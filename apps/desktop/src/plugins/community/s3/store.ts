import { createRemoteSourceStore } from "../_remoteSource/store";
import type { RemoteStatus } from "../_remoteSource/logic";

export const S3_PREFIX = "s3:";

export interface S3Status extends RemoteStatus {
  endpoint?: string | null;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  /** Chosen key prefixes; empty means the whole bucket. */
  folders?: string[];
}

export const useS3 = createRemoteSourceStore<S3Status>({
  area: "s3",
  prefix: S3_PREFIX,
  source: "s3",
  label: "S3 storage",
});

export interface Preset {
  id: string;
  label: string;
  endpoint: string;
  region: string;
  help: string;
}

/** Starting points for the connect form. Nothing here is a secret or a default the server relies on. */
export const PRESETS: Preset[] = [
  {
    id: "aws",
    label: "Amazon S3",
    endpoint: "",
    region: "us-east-1",
    help: "Make an IAM user for Cadence that can only list and read the bucket (s3:ListBucket and s3:GetObject), and create an access key for it.",
  },
  {
    id: "b2",
    label: "Backblaze B2",
    endpoint: "https://s3.us-west-004.backblazeb2.com",
    region: "us-west-004",
    help: "Use an application key that can read this bucket. Your bucket page shows the S3 endpoint and region to copy here.",
  },
  {
    id: "r2",
    label: "Cloudflare R2",
    endpoint: "https://ACCOUNT-ID.r2.cloudflarestorage.com",
    region: "auto",
    help: "Create an R2 API token with read access to the bucket. Replace ACCOUNT-ID with your Cloudflare account ID; the region stays auto.",
  },
  {
    id: "minio",
    label: "MinIO or another server",
    endpoint: "http://minio.local:9000",
    region: "us-east-1",
    help: "A server on your own network needs the server owner to allow private networks (Server owner options below).",
  },
];
