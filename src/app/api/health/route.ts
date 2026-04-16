/**
 * Health check endpoint for monitoring
 * Returns application and database status
 * Used by monitoring systems and deployment verifications
 */

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { logger, ApiError } from '@/lib/error-handler';

interface HealthCheckResponse {
  status: 'up' | 'degraded' | 'down';
  timestamp: string;
  uptime: number;
  checks: {
    database: {
      status: 'healthy' | 'unhealthy';
      responseTime: number;
      error?: unknown;
    };
    environment: {
      status: 'healthy' | 'unhealthy';
      missingVars?: string[];
    };
  };
}

// Track start time for uptime calculation
const startTime = Date.now();

export async function GET(): Promise<NextResponse<HealthCheckResponse>> {
  const timestamp = new Date().toISOString();
  const uptime = Date.now() - startTime;
  let overallStatus: 'up' | 'degraded' | 'down' = 'up';

  // Check environment variables
  const requiredVars = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ];

  const missingVars = requiredVars.filter((v) => !process.env[v]);

  const environmentCheck = {
    status: missingVars.length === 0 ? ('healthy' as const) : ('unhealthy' as const),
    ...(missingVars.length > 0 && { missingVars }),
  };

  if (missingVars.length > 0) {
    overallStatus = 'degraded';
    logger.warn('Health check: Missing environment variables', { missingVars });
  }

  // Check database connectivity
  let databaseCheck: HealthCheckResponse['checks']['database'] = {
    status: 'unhealthy',
    responseTime: 0,
  };

  try {
    const dbStartTime = Date.now();

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Simple query to verify connection
    const { error, data } = await supabase
      .from('clientes')
      .select('id')
      .limit(1);

    const responseTime = Date.now() - dbStartTime;

    if (error) {
      logger.warn('Health check: Database query failed', { error: error.message });
      databaseCheck = {
        status: 'unhealthy',
        responseTime,
        error: error.message,
      };
      overallStatus = 'degraded';
    } else {
      databaseCheck = {
        status: 'healthy',
        responseTime,
      };
    }
  } catch (error) {
    const responseTime = Date.now() - (startTime || 0);
    const message = error instanceof Error ? error.message : 'Connection failed';

    logger.error('Health check: Database connection error', error, {
      responseTime,
    });

    databaseCheck = {
      status: 'unhealthy',
      responseTime,
      error: message,
    };
    overallStatus = 'degraded';
  }

  const response: HealthCheckResponse = {
    status: overallStatus,
    timestamp,
    uptime,
    checks: {
      database: databaseCheck,
      environment: environmentCheck,
    },
  };

  // Return appropriate status code
  const statusCode = overallStatus === 'up' ? 200 : overallStatus === 'degraded' ? 503 : 503;

  return NextResponse.json(response, { status: statusCode });
}

/**
 * POST endpoint for triggering health check with custom checks
 * Used for monitoring scripts that need extended checks
 */
export async function POST(): Promise<NextResponse<HealthCheckResponse>> {
  // For now, just return the same as GET
  // Can be extended to run more expensive checks
  return GET();
}
