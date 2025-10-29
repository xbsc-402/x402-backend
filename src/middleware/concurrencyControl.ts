/**
 * Concurrency control middleware
 * All functionality has been removed
 */

import { type Request, type Response, type NextFunction } from 'express';

// Export empty middleware function to maintain compatibility
export function deduplicationMiddleware(_req: Request, _res: Response, next: NextFunction) {
  next();
}

export function addressCooldownMiddleware(_req: Request, _res: Response, next: NextFunction) {
  next();
}