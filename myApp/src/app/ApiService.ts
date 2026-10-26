import { Injectable } from '@angular/core';
   import { HttpClient } from '@angular/common/http';
   import { Observable } from 'rxjs';

   export interface GradeResult {
     score: number;
     feedback: string;
     suggestions: string[];
   }

   export type GradeStreamEvent =
     | { type: 'score'; value: number }
     | { type: 'feedback_start' }
     | { type: 'feedback_delta'; delta: string }
     | { type: 'feedback_complete' }
     | { type: 'suggestions_start' }
     | { type: 'suggestion_start'; index: number }
     | { type: 'suggestion_delta'; index: number; delta: string }
     | { type: 'suggestion_complete' }
     | { type: 'suggestions_complete' }
     | { type: 'done'; result: GradeResult }
     | { type: 'error'; error: string };

   function isGradeResult(value: unknown): value is GradeResult {
     if (typeof value !== 'object' || value === null || !('score' in value) ||
       !('feedback' in value) || !('suggestions' in value)) {
       return false;
     }
     return typeof value.score === 'number' &&
       Number.isInteger(value.score) &&
       value.score >= 0 &&
       value.score <= 100 &&
       typeof value.feedback === 'string' &&
       Array.isArray(value.suggestions) &&
       value.suggestions.every((suggestion: unknown) => typeof suggestion === 'string');
   }

   @Injectable({
     providedIn: 'root'
   })
   export class ApiService {
     private baseUrl = 'http://localhost:8000';

     constructor(private http: HttpClient) { }

     gradeSolutionStream(solution: string): Observable<GradeStreamEvent> {
       return new Observable<GradeStreamEvent>(subscriber => {
         const controller = new AbortController();

         const readStream = async (): Promise<void> => {
           try {
             const response = await fetch(`${this.baseUrl}/grade/stream`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ solution }),
               signal: controller.signal,
             });

             if (!response.ok) {
               const errorBody = await response.text();
               throw new Error(errorBody || `בדיקת התרגיל נכשלה (${response.status})`);
             }
             if (!response.body) {
               throw new Error('הדפדפן לא קיבל זרם תשובה מהשרת');
             }

             const reader = response.body.getReader();
             const decoder = new TextDecoder();
             let buffer = '';
             let receivedDone = false;

             const processFrame = (frame: string): boolean => {
               const data = frame
                 .split('\n')
                 .filter(line => line.startsWith('data:'))
                 .map(line => line.slice(5).trimStart())
                 .join('\n');
               if (!data) {
                 return false;
               }

               const parsed: unknown = JSON.parse(data);
               if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
                 throw new Error('השרת שלח אירוע בדיקה לא תקין');
               }

               const event = parsed as Record<string, unknown>;
               if (event['type'] === 'error' && typeof event['error'] === 'string') {
                 throw new Error(event['error']);
               }
               if (event['type'] === 'score' && typeof event['value'] === 'number') {
                 subscriber.next({ type: 'score', value: event['value'] });
                 return false;
               }
               if (event['type'] === 'feedback_delta' && typeof event['delta'] === 'string') {
                 subscriber.next({ type: 'feedback_delta', delta: event['delta'] });
                 return false;
               }
               if (
                 event['type'] === 'suggestion_delta' &&
                 typeof event['delta'] === 'string' &&
                 typeof event['index'] === 'number' &&
                 Number.isInteger(event['index'])
               ) {
                 subscriber.next({
                   type: 'suggestion_delta',
                     index: event['index'],
                     delta: event['delta'],
                 });
                 return false;
               }
               if (
                 event['type'] === 'suggestion_start' &&
                 typeof event['index'] === 'number' &&
                 Number.isInteger(event['index'])
               ) {
                 subscriber.next({ type: 'suggestion_start', index: event['index'] });
                 return false;
               }
               if (
                 event['type'] === 'feedback_complete' ||
                 event['type'] === 'feedback_start' ||
                 event['type'] === 'suggestions_start' ||
                 event['type'] === 'suggestion_complete' ||
                 event['type'] === 'suggestions_complete'
               ) {
                 subscriber.next({ type: event['type'] });
                 return false;
               }
               if (event['type'] === 'done') {
                 if (!isGradeResult(event['result'])) {
                     throw new Error('השרת החזיר תוצאת בדיקה לא תקינה');
                 }
                 receivedDone = true;
                 subscriber.next({ type: 'done', result: event['result'] });
                 subscriber.complete();
                 return true;
               }

               throw new Error('השרת שלח אירוע בדיקה לא מוכר');
             };

             while (true) {
               const { done, value } = await reader.read();
               buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');

               let separator = buffer.indexOf('\n\n');
               let streamFinished = false;
               while (separator !== -1) {
                 const frame = buffer.slice(0, separator);
                 buffer = buffer.slice(separator + 2);
                 if (processFrame(frame)) {
                   streamFinished = true;
                   break;
                 }
                 separator = buffer.indexOf('\n\n');
               }

               if (streamFinished || done) {
                 if (!streamFinished && buffer.trim()) {
                   processFrame(buffer);
                 }
                 break;
               }
             }

             if (!receivedDone) {
               throw new Error('זרם הבדיקה הסתיים לפני שהתקבלה תוצאה מלאה');
             }
             reader.releaseLock();
           } catch (error) {
             if (!controller.signal.aborted) {
               subscriber.error(error);
             }
           }
         };

         void readStream();
         return () => controller.abort();
       });
     }

     healthCheck(): Observable<any> {
       return this.http.get(`${this.baseUrl}/health`);
     }
   }