import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Notes on Reports issues (Plan 48): what a person looked up and found, for
 * whoever decides. One per issue; an empty text clears it.
 */

export const ISSUE_NOTE_PAGES = ['sales', 'catalog'] as const;
export type IssueNotePage = (typeof ISSUE_NOTE_PAGES)[number];

export const SaveIssueNoteSchema = z.object({
  /** Sales check: the issue's key. Catalog check: `sku|kind|field`. */
  issueKey: z.string().min(1).max(200),
  text: z.string().max(2000),
}).strict();
export class SaveIssueNoteDto extends createZodDto(SaveIssueNoteSchema) {}

export interface IssueNote {
  text: string;
  updatedByName: string | null;
  updatedAt: string;
}

/** A page's notes, by issue key. */
export type IssueNotesResponse = Record<string, IssueNote>;
