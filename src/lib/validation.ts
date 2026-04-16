/**
 * Input validation schemas for API routes
 * Uses Zod for type-safe validation
 */

import { z } from 'zod';
import { ApiError } from './error-handler';

/**
 * Schema for the worker API query parameters
 */
export const workerQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format. Use YYYY-MM-DD').optional(),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid start date format. Use YYYY-MM-DD').optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid end date format. Use YYYY-MM-DD').optional(),
  client_id: z.string().uuid('Invalid client ID format').optional(),
});

export type WorkerQueryParams = z.infer<typeof workerQuerySchema>;

/**
 * Validate query parameters from a URL
 */
export function validateQueryParams<T extends z.ZodSchema>(
  searchParams: URLSearchParams,
  schema: T
): z.infer<T> {
  const params = Object.fromEntries(searchParams);

  try {
    return schema.parse(params);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Invalid query parameters',
        400,
        error.issues.map((e: any) => ({
          field: e.path.join('.'),
          message: e.message,
        }))
      );
    }

    throw error;
  }
}

/**
 * Validate environment variables are set
 */
export function validateEnvVars(required: string[]): void {
  const missing = required.filter(v => !process.env[v]);

  if (missing.length > 0) {
    throw new ApiError(
      'INVALID_CONFIG',
      'Missing required environment variables',
      500,
      { missing }
    );
  }
}

/**
 * Validate Supabase client is initialized
 */
export function validateSupabaseClient(client: unknown): asserts client is { from: Function } {
  if (!client || typeof client !== 'object' || !('from' in client)) {
    throw new ApiError(
      'INVALID_CONFIG',
      'Supabase client not properly initialized',
      500
    );
  }
}
