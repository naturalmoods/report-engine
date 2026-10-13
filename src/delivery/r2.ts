import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";

// Storage adapter: fake in tests. X-Robots-Tag: noindex can NOT be set with the S3 PutObject (R2 does not put custom metadata
// into response headers; I did not find this in the Cloudflare documentation: not verified), so on the custom domain
// a Transform Rule provides it (see README). The report HTML also has <meta name="robots" content="noindex, nofollow">.
export interface Storage {
  put(key: string, html: string, cacheControl: string): Promise<void>;
}

const client = (env: Record<string, string>) =>
  new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });

// Storage for backups (R2_BUCKET_BACKUPS); fake in tests.
export interface BackupStore {
  put(key: string, file: string): Promise<void>;
  list(): Promise<string[]>;
  remove(key: string): Promise<void>;
}

export function r2Backups(env: Record<string, string>): BackupStore {
  const s3 = client(env);
  const Bucket = env.R2_BUCKET_BACKUPS;
  return {
    // ponytail: the gzipped backup is held in memory whole; the SQLite file is MB-sized, streaming is needed if it becomes GB-sized.
    async put(key, file) {
      await s3.send(new PutObjectCommand({ Bucket, Key: s3Key(key), Body: readFileSync(file), ContentType: "application/gzip" }));
    },
    async list() {
      const keys: string[] = [];
      let ContinuationToken: string | undefined;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
        keys.push(...(r.Contents ?? []).map((o) => o.Key!));
        ContinuationToken = r.NextContinuationToken;
      } while (ContinuationToken);
      return keys;
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: s3Key(key) }));
    },
  };
}

// The S3 key must not start with "/" (the SDK would send a //r/... path, while the public URL points to the "r/..." key).
export const s3Key = (key: string): string => key.replace(/^\/+/, "");

export function r2Storage(env: Record<string, string>, s3: Pick<S3Client, "send"> = client(env)): Storage {
  return {
    async put(key, html, cacheControl) {
      await s3.send(
        new PutObjectCommand({ Bucket: env.R2_BUCKET_REPORTS, Key: s3Key(key), Body: html, ContentType: "text/html; charset=utf-8", CacheControl: cacheControl }),
      );
    },
  };
}
