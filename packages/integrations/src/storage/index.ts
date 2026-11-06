import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type S3Config = {
  /** Unset on AWS; the MinIO URL locally. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

/**
 * Private bucket, presigned access only (D-06). Uploads use presigned POST so S3 itself enforces
 * the exact key, content type and maximum size.
 */
export class S3Storage {
  private readonly client: S3Client;

  constructor(private readonly config: S3Config) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async createUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
  }) {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.config.bucket,
      Key: input.key,
      Conditions: [
        ["content-length-range", 1, input.maxBytes],
        ["eq", "$Content-Type", input.contentType],
      ],
      Fields: { "Content-Type": input.contentType },
      Expires: 300,
    });
    return { url, fields };
  }

  async head(
    key: string,
  ): Promise<{ size: number; contentType: string | null } | null> {
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        size: out.ContentLength ?? 0,
        contentType: out.ContentType ?? null,
      };
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404 || status === 403) return null;
      throw err;
    }
  }

  async getUrl(key: string, expiresInSeconds = 300): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  /** Reads a small text object (CSV imports). Refuses anything over `maxBytes`. */
  async getText(key: string, maxBytes = 10 * 1024 * 1024): Promise<string> {
    const out = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if ((out.ContentLength ?? 0) > maxBytes)
      throw new Error("Object too large");
    return (await out.Body?.transformToString("utf-8")) ?? "";
  }

  /** Writes a server-generated object (exports, invoice PDFs). */
  async put(
    key: string,
    body: string | Uint8Array,
    contentType: string,
  ): Promise<{ size: number }> {
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );
    return { size: bytes.byteLength };
  }
}
