import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, getR2BucketName } from '../config';

/**
 * Mount R2 bucket for persistent storage
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if mounted successfully, false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log(
      'R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)',
    );
    return false;
  }

  const bucketName = getR2BucketName(env);

  try {
    console.log('Mounting R2 bucket', bucketName, 'at', R2_MOUNT_PATH);
    await sandbox.mountBucket(bucketName, R2_MOUNT_PATH, {
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log('R2 bucket mounted successfully');
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Check for "already mounted" error types - treat as success
    if (
      errorMessage.includes('already mounted') ||
      errorMessage.includes('Device or resource busy') ||
      errorMessage.includes('InvalidMountConfigError')
    ) {
      console.log('R2 bucket was already mounted (treating as success):', errorMessage);
      return true;
    }

    // Genuine failure
    console.error('Failed to mount R2 bucket:', errorMessage);
    return false;
  }
}
