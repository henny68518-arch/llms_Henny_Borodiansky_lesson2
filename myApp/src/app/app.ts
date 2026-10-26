import { AfterViewChecked, Component, ElementRef, viewChild, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, GradeResult, GradeStreamEvent } from './ApiService';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

type AppMode = 'chat' | 'program';

interface GradeProgress {
  score: number | null;
  feedback: string;
  feedbackComplete: boolean;
  suggestions: string[];
  suggestionsComplete: boolean;
  complete: boolean;
}

@Component({
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
  imports: [FormsModule],
})
export class App implements AfterViewChecked {
  readonly mode = signal<AppMode>('chat');

  /** היסטוריית השיחה המוצגת במסך */
  readonly messages = signal<ChatMessage[]>([]);

  readonly solution = signal('');

  readonly lastSubmittedSolution = signal<string | null>(null);

  readonly gradeProgress = signal<GradeProgress | null>(null);

  readonly isGrading = signal(false);

  /** תוכן שדה הקלט */
  readonly draft = signal('');

  /** האם ממתינים לתשובה מהשרת */
  readonly isSending = signal(false);

  /** שגיאה אחרונה, אם הייתה */
  readonly errorText = signal('');

  /** שדה הקלט — לגלילה אוטומטית ולשחזור הפוקוס */
  private readonly draftInput = viewChild<ElementRef<HTMLTextAreaElement>>('draftInput');

  private readonly chatStream = viewChild<ElementRef<HTMLElement>>('chatStream');

  private shouldScrollChat = false;

  constructor(private apiService: ApiService) { }

  ngAfterViewChecked(): void {
    if (!this.shouldScrollChat) {
      return;
    }
    this.shouldScrollChat = false;
    const stream = this.chatStream()?.nativeElement;
    if (stream) {
      stream.scrollTop = stream.scrollHeight;
    }
  }

  setMode(mode: AppMode): void {
    if (this.isSending() || this.isGrading()) {
      return;
    }
    this.mode.set(mode);
    this.errorText.set('');
  }

  setSolution(value: string): void {
    this.solution.set(value);
  }

  submitSolution(): void {
    const solution = this.solution().trim();
    if (!solution || this.isGrading()) {
      return;
    }

    this.lastSubmittedSolution.set(solution);
    this.gradeProgress.set({
      score: null,
      feedback: '',
      feedbackComplete: false,
      suggestions: [],
      suggestionsComplete: false,
      complete: false,
    });
    this.errorText.set('');
    this.isGrading.set(true);

    this.apiService.gradeSolutionStream(solution).subscribe({
      next: event => this.handleProgramGradeEvent(event),
      error: (error) => {
        console.error('Grading error:', error);
        this.errorText.set(
          error?.error?.detail ?? error?.message ?? 'בדיקת התרגיל נכשלה'
        );
        this.isGrading.set(false);
      },
      complete: () => this.isGrading.set(false),
    });
  }

  resetSolution(): void {
    if (this.isGrading()) {
      return;
    }
    this.solution.set('');
    this.gradeProgress.set(null);
    this.errorText.set('');
  }

  private handleProgramGradeEvent(event: GradeStreamEvent): void {
    if (event.type === 'score') {
      this.gradeProgress.update(result => result
        ? { ...result, score: event.value }
        : result);
    } else if (event.type === 'feedback_delta') {
      this.gradeProgress.update(result => result
        ? { ...result, feedback: result.feedback + event.delta }
        : result);
    } else if (event.type === 'feedback_complete') {
      this.gradeProgress.update(result => result
        ? { ...result, feedbackComplete: true }
        : result);
    } else if (event.type === 'suggestion_start') {
      this.gradeProgress.update(result => {
        if (!result) {
          return result;
        }
        const suggestions = [...result.suggestions];
        suggestions[event.index] = '';
        return { ...result, suggestions };
      });
    } else if (event.type === 'suggestion_delta') {
      this.gradeProgress.update(result => {
        if (!result) {
          return result;
        }
        const suggestions = [...result.suggestions];
        suggestions[event.index] = (suggestions[event.index] ?? '') + event.delta;
        return { ...result, suggestions };
      });
    } else if (event.type === 'suggestions_complete') {
      this.gradeProgress.update(result => result
        ? { ...result, suggestionsComplete: true }
        : result);
    } else if (event.type === 'done') {
      this.gradeProgress.set({
        ...event.result,
        feedbackComplete: true,
        suggestionsComplete: true,
        complete: true,
      });
    }
  }

  /**
   * Enter שולח, Shift+Enter יורד שורה.
   * בזמן הקלדה עם IME (למשל עברית/סינית) מתעלמים — ה-Enter שייך לשיטת הקלט.
   */
  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    this.send();
  }

  /** התאמת גובה תיבת הקלט למספר השורות, עד תקרה */
  private resizeInput(): void {
    const el = this.draftInput()?.nativeElement;
    if (!el) {
      return;
    }
    // אחרי שהתבנית עודכנה (ריקון השדה, שורה חדשה) — מודדים מחדש
    requestAnimationFrame(() => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    });
  }

  send(): void {
    const text = this.draft().trim();
    if (!text || this.isSending()) {
      return;
    }

    this.messages.update(messages => [
      ...messages,
      { role: 'user', text } as ChatMessage,
      { role: 'assistant', text: '' } as ChatMessage,
    ]);
    this.shouldScrollChat = true;

    this.draft.set('');
    this.resizeInput();
    this.errorText.set('');
    this.isSending.set(true);

    let feedbackHeaderSent = false;
    let suggestionsHeaderSent = false;
    let suggestionCount = 0;

    this.apiService.gradeSolutionStream(text).subscribe({
      next: event => {
        if (event.type === 'score') {
          this.appendAssistantText(`ציון: ${event.value}%\n`);
        } else if (event.type === 'feedback_start') {
          if (!feedbackHeaderSent) {
            this.appendAssistantText('משוב: ');
            feedbackHeaderSent = true;
          }
        } else if (event.type === 'feedback_delta') {
          if (!feedbackHeaderSent) {
            this.appendAssistantText('משוב: ');
            feedbackHeaderSent = true;
          }
          this.appendAssistantText(event.delta);
        } else if (event.type === 'feedback_complete') {
          this.appendAssistantText('\n');
        } else if (event.type === 'suggestions_start') {
          this.appendAssistantText('\nהצעות לשיפור:\n');
          suggestionsHeaderSent = true;
        } else if (event.type === 'suggestion_start') {
          suggestionCount += 1;
          this.appendAssistantText('• ');
        } else if (event.type === 'suggestion_delta') {
          this.appendAssistantText(event.delta);
        } else if (event.type === 'suggestion_complete') {
          this.appendAssistantText('\n');
        } else if (event.type === 'suggestions_complete' && suggestionCount === 0) {
          this.appendAssistantText('אין הצעות לשיפור.\n');
        } else if (event.type === 'done' && !suggestionsHeaderSent) {
          this.appendAssistantText('\nהצעות לשיפור:\nאין הצעות לשיפור.\n');
        }
      },
      error: (error) => {
        console.error('Error:', error);
        this.messages.update(list => {
          const lastMessage = list[list.length - 1];
          return lastMessage?.role === 'assistant' && !lastMessage.text
            ? list.slice(0, -1)
            : list;
        });
        this.errorText.set(
          error?.message ?? 'שגיאה לא ידועה'
        );
        this.isSending.set(false);
      },
      complete: () => this.isSending.set(false),
    });
  }

  private appendAssistantText(text: string): void {
    this.messages.update(list => {
      const copy = [...list];
      const lastMessage = copy[copy.length - 1];
      if (lastMessage?.role === 'assistant') {
        copy[copy.length - 1] = {
          ...lastMessage,
          text: lastMessage.text + text,
        };
      }
      return copy;
    });
  }

  clear(): void {
    if (this.isSending()) {
      return;
    }
    this.messages.set([]);
    this.errorText.set('');
  }

  /** משנה את תוכן שדה הקלט */
  setDraft(value: string): void {
    this.draft.set(value);
    this.resizeInput();
  }
}
