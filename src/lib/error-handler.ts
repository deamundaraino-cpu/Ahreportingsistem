/**
 * Centralized error handling and logging utilities
 * Ensures consistent error responses and logging across API routes
 */

import { NextResponse } from 'next/server';

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'TIMEOUT'
  | 'INVALID_CONFIG'
  | 'EXTERNAL_API_ERROR'
  | 'DATABASE_ERROR';

export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
    timestamp: string;
  };
}

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public statusCode: number = 500,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Structured logging with timestamp and context
 */
export const logger = {
  info: (message: string, context?: Record<string, unknown>) => {
    console.log(JSON.stringify({
      level: 'info',
      timestamp: new Date().toISOString(),
      message,
      ...context,
    }));
  },

  warn: (message: string, context?: Record<string, unknown>) => {
    console.warn(JSON.stringify({
      level: 'warn',
      timestamp: new Date().toISOString(),
      message,
      ...context,
    }));
  },

  error: (message: string, error?: unknown, context?: Record<string, unknown>) => {
    const errorObj = error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : error;

    console.error(JSON.stringify({
      level: 'error',
      timestamp: new Date().toISOString(),
      message,
      error: errorObj,
      ...context,
    }));
  },

  debug: (message: string, context?: Record<string, unknown>) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(JSON.stringify({
        level: 'debug',
        timestamp: new Date().toISOString(),
        message,
        ...context,
      }));
    }
  },
};

/**
 * Convert ApiError to NextResponse JSON
 */
export function apiErrorResponse(error: ApiError): NextResponse<ApiErrorResponse> {
  logger.error(error.message, error, {
    code: error.code,
    statusCode: error.statusCode,
    details: error.details,
  });

  return NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(process.env.NODE_ENV === 'development' && { details: error.details }),
        timestamp: new Date().toISOString(),
      },
    },
    { status: error.statusCode }
  );
}

/**
 * Handle unexpected errors with safe fallback
 */
export function handleUnexpectedError(error: unknown, context?: string): NextResponse<ApiErrorResponse> {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const errorObj = error instanceof Error ? error : new Error(String(error));

  logger.error(
    'Unexpected error',
    errorObj,
    { context, message }
  );

  return NextResponse.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. Please try again later.',
        timestamp: new Date().toISOString(),
      },
    },
    { status: 500 }
  );
}

/**
 * Fetch with timeout and error handling
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout?: number } = {}
): Promise<Response> {
  const timeout = options.timeout || 30000; // 30s default
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ApiError(
        'EXTERNAL_API_ERROR',
        `External API returned ${response.status}`,
        response.status,
        { url, status: response.status }
      );
    }

    return response;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('abort')) {
      throw new ApiError(
        'TIMEOUT',
        `Request to ${new URL(url).hostname} timed out after ${timeout}ms`,
        504,
        { url, timeout }
      );
    }

    if (error instanceof ApiError) {
      throw error;
    }

    throw new ApiError(
      'EXTERNAL_API_ERROR',
      `Failed to fetch from ${new URL(url).hostname}`,
      502,
      { url, error: error instanceof Error ? error.message : String(error) }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Safely parse JSON response from API
 */
export async function safeJsonParse<T>(response: Response): Promise<T> {
  try {
    return await response.json();
  } catch (error) {
    throw new ApiError(
      'EXTERNAL_API_ERROR',
      'Failed to parse API response as JSON',
      502,
      { error: error instanceof Error ? error.message : String(error) }
    );
  }
}
