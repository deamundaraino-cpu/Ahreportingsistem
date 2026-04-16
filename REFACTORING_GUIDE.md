# 📋 Refactoring Guide - Error Handling & Validation

This document shows how to refactor API routes for better stability and maintainability.

## Problem: Current `/api/worker/route.ts`

- **700+ lines** in a single file
- **Mixed concerns:** API input, Meta fetch, GA4 fetch, Hotmart fetch, database updates
- **Weak error handling:** Many try-catch blocks with generic error messages
- **No input validation:** Query params parsed without schema validation
- **Type safety:** Multiple `any` types
- **Hard to test:** Everything is coupled in one route

## Solution: Modular Architecture with Error Handling

### Step 1: Validate Inputs

**Before:**
```typescript
const singleDate = searchParams.get('date')
const startDateStr = singleDate || searchParams.get('start') || format(subDays(new Date(), 1), 'yyyy-MM-dd')
```

**After:**
```typescript
import { validateQueryParams, workerQuerySchema } from '@/lib/validation';
import { logger, ApiError } from '@/lib/error-handler';

const params = validateQueryParams(new URL(request.url).searchParams, workerQuerySchema);
```

This provides:
- ✅ Type safety: `params` is now typed as `WorkerQueryParams`
- ✅ Clear error messages if dates are invalid
- ✅ Reusable validation logic

### Step 2: Improve Fetch Calls

**Before:**
```typescript
const res = await fetch(url.toString())
const data = await res.json()
if (data.error) {
  log(`Error: ${JSON.stringify(data.error)}`)
}
```

**After:**
```typescript
import { fetchWithTimeout, safeJsonParse } from '@/lib/error-handler';

try {
  const response = await fetchWithTimeout(url.toString(), { timeout: 30000 });
  const data = await safeJsonParse(response);
  // Use data...
} catch (error) {
  logger.error('Meta API fetch failed', error, { url });
  throw error; // Let caller handle or catch at route level
}
```

This provides:
- ✅ Automatic timeouts (30s default)
- ✅ Consistent error handling
- ✅ Better error context
- ✅ Easy to test (mock fetch)

### Step 3: Create Modular Fetchers

**File: `src/lib/integrations/meta-fetcher.ts`**

```typescript
import { fetchWithTimeout, safeJsonParse, logger, ApiError } from '@/lib/error-handler';

interface MetaConfig {
  token: string;
  account_id: string;
}

export async function fetchMetaCampaigns(
  config: MetaConfig,
  targetDate: string
): Promise<MetaCampaignData> {
  try {
    const url = buildMetaUrl(config, targetDate);
    const response = await fetchWithTimeout(url, { timeout: 30000 });
    const data = await safeJsonParse<MetaApiResponse>(response);

    if (!data.data) {
      logger.warn('No Meta data returned', { targetDate, accountId: config.account_id });
      return emptyMetaData();
    }

    return parseMetaCampaigns(data.data);
  } catch (error) {
    logger.error('Failed to fetch Meta campaigns', error, {
      accountId: config.account_id,
      targetDate,
    });
    throw new ApiError(
      'EXTERNAL_API_ERROR',
      'Failed to fetch Meta Ads data',
      502,
      { provider: 'meta', targetDate }
    );
  }
}

function buildMetaUrl(config: MetaConfig, targetDate: string): string {
  const url = new URL(`https://graph.facebook.com/v19.0/act_${config.account_id}/insights`);
  url.searchParams.append('access_token', config.token);
  url.searchParams.append('time_range', JSON.stringify({ since: targetDate, until: targetDate }));
  url.searchParams.append('fields', 'campaign_name,spend,impressions,clicks,...');
  // ... other params
  return url.toString();
}

function parseMetaCampaigns(data: unknown[]): MetaCampaignData {
  // Type-safe parsing with validation
  // Throw ApiError if data format is unexpected
}
```

**Benefits:**
- ✅ Single responsibility: Only handles Meta API
- ✅ Easy to test: Just mock `fetchWithTimeout`
- ✅ Reusable: Import in other routes or workers
- ✅ Better error messages: Context about what failed

### Step 4: Wrap Route in Try-Catch

**File: `src/app/api/worker/route.ts`** (Simplified)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { validateQueryParams, workerQuerySchema } from '@/lib/validation';
import { apiErrorResponse, handleUnexpectedError, logger } from '@/lib/error-handler';
import { authenticateCron } from '@/lib/cron-auth';
import { syncClientData } from './sync-worker';

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate
    authenticateCron(request);

    // 2. Validate input
    const params = validateQueryParams(
      new URL(request.url).searchParams,
      workerQuerySchema
    );

    // 3. Do the work
    const result = await syncClientData(params);

    // 4. Return success
    logger.info('Worker completed successfully', {
      clientsProcessed: result.clientCount,
      datesProcessed: result.dateCount,
      duration: result.duration,
    });

    return NextResponse.json(result);
  } catch (error) {
    // Catches ApiError and formats as JSON
    if (error instanceof ApiError) {
      return apiErrorResponse(error);
    }

    // Unexpected errors
    return handleUnexpectedError(error, 'worker_route');
  }
}
```

### Step 5: Type Safety for Supabase

**Before:**
```typescript
let adminSupabase: any;
const config = cliente.config_api as any;
```

**After:**
```typescript
import { SupabaseClient } from '@supabase/supabase-js';
import { Database } from '@/types/database';

const adminSupabase: SupabaseClient<Database> = createClient(...);

interface ClientConfig {
  meta_token?: string;
  meta_account_id?: string;
  hotmart_basic?: string;
  // ... other fields
}

const config: ClientConfig = cliente.config_api;
if (!config.meta_token) {
  throw new ApiError('INVALID_CONFIG', 'Meta token not configured for client');
}
```

**Benefits:**
- ✅ TypeScript autocomplete for Supabase methods
- ✅ Compile-time type checking
- ✅ Clear contract of what config can contain

---

## Implementation Roadmap

### Phase 1: Foundation (This Week)
- [ ] Add `error-handler.ts` utility ✅ Done
- [ ] Add `validation.ts` utility ✅ Done
- [ ] Create `cron-auth.ts` for auth logic
- [ ] Test utilities with simple route

### Phase 2: Refactor Worker (Next Week)
- [ ] Extract Meta fetcher to `integrations/meta-fetcher.ts`
- [ ] Extract GA4 fetcher to `integrations/ga4-fetcher.ts`
- [ ] Extract Hotmart fetcher to `integrations/hotmart-fetcher.ts`
- [ ] Create `sync-worker.ts` orchestrator
- [ ] Simplify `/api/worker/route.ts`

### Phase 3: Fix Type Safety (Week 3)
- [ ] Generate Database types from Supabase schema
- [ ] Remove all `any` types from route handlers
- [ ] Add strict TypeScript checks

### Phase 4: Tests (Week 4)
- [ ] Unit tests for each fetcher
- [ ] Integration test for sync workflow
- [ ] Mock external APIs

---

## Quick Start: Refactor One Route

Try this pattern on a simpler route first (e.g., `/api/layouts/reorder`):

```typescript
// ✅ Good pattern to follow
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError, logger, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';
import { validateQueryParams } from '@/lib/validation';

const schema = z.object({
  layout_id: z.string().uuid(),
  direction: z.enum(['up', 'down']),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const params = schema.parse(body);

    // Do work...

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiErrorResponse(
        new ApiError('VALIDATION_ERROR', 'Invalid request body', 400, error.errors)
      );
    }

    if (error instanceof ApiError) {
      return apiErrorResponse(error);
    }

    return handleUnexpectedError(error, 'reorder_layout');
  }
}
```

---

## Testing the Refactored Code

```typescript
// tests/integrations/meta-fetcher.test.ts
import { fetchMetaCampaigns } from '@/lib/integrations/meta-fetcher';
import * as fetch from '@/lib/error-handler';

jest.mock('@/lib/error-handler');

test('should handle API timeout', async () => {
  (fetch.fetchWithTimeout as jest.Mock).mockRejectedValue(
    new ApiError('TIMEOUT', 'Request timed out', 504)
  );

  await expect(
    fetchMetaCampaigns({ token: 'xxx', account_id: 'yyy' }, '2024-01-01')
  ).rejects.toThrow('Failed to fetch Meta Ads data');
});
```

---

## Monitoring Impact

With these changes, you'll be able to:
- ✅ See clear error messages in logs
- ✅ Distinguish API errors from code errors
- ✅ Monitor specific failure types
- ✅ Debug faster with context
- ✅ Add Sentry/monitoring later without re-coding

