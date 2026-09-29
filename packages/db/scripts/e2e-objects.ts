// Object-storage side of the E2E cleanup (review P2-CC-6): deleting the suite's tickets cascades
// their Attachment rows, but the files stay in S3 / MinIO unless they are removed too. The keys
// are read from the rows before they are deleted; every server-side copy of an attachment lives
// under `files/<attachmentId>/` and its browser upload under `attachments/<attachmentId>/`
// (apps/api lib/storage.ts), so both prefixes are swept as well — the upload one because a POST
// with the still-valid pre-signed policy after `complete` recreates an object no row references
// (review RR-SEC-4).
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { parseBooleanEnv } from '@loons/shared';

/** Prefix of the API's server-only copies of confirmed uploads. */
export const STORED_KEY_PREFIX = 'files';
/** Prefix of the browser uploads (pre-signed POST targets). */
export const UPLOAD_KEY_PREFIX = 'attachments';

export interface ObjectTargets {
  /** Exact object keys. */
  keys: string[];
  /** Key prefixes whose objects are all removed (each ends with "/"). */
  prefixes: string[];
}

/**
 * What to delete for the given attachment rows: their key, their `files/<id>/` copies and
 * whatever is left under their `attachments/<id>/` upload prefix.
 */
export function attachmentObjectTargets(
  rows: ReadonlyArray<{ id: string; storageKey: string }>,
): ObjectTargets {
  const keys = [...new Set(rows.map((r) => r.storageKey).filter((k) => k.length > 0))];
  const ids = [...new Set(rows.map((r) => r.id))];
  const prefixes = [
    ...ids.map((id) => `${STORED_KEY_PREFIX}/${id}/`),
    ...ids.map((id) => `${UPLOAD_KEY_PREFIX}/${id}/`),
  ];
  return { keys, prefixes };
}

/** S3 client settings from the same variables the API reads (null when storage isn't set up). */
export function s3FromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { bucket: string; config: S3ClientConfig } | null {
  const bucket = env.S3_BUCKET?.trim();
  const region = env.S3_REGION?.trim();
  if (!bucket || !region) return null;
  const config: S3ClientConfig = {
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  const endpoint = env.S3_ENDPOINT?.trim();
  if (endpoint) {
    config.endpoint = endpoint;
    config.forcePathStyle = parseBooleanEnv('S3_FORCE_PATH_STYLE', env.S3_FORCE_PATH_STYLE, false);
  }
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (accessKeyId && secretAccessKey) config.credentials = { accessKeyId, secretAccessKey };
  return { bucket, config };
}

/** Deletes the targets' objects; returns how many objects were deleted. */
export async function deleteObjects(
  client: S3Client,
  bucket: string,
  targets: ObjectTargets,
): Promise<number> {
  const keys = new Set(targets.keys);
  for (const prefix of targets.prefixes) {
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const object of page.Contents ?? []) if (object.Key) keys.add(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  // One request per key: the suite leaves a handful, and DeleteObjects needs checksum headers
  // that not every S3-compatible store accepts. Deleting a missing key is not an error.
  for (const key of keys) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  return keys.size;
}
