import type { Plugin } from "../../types";
import { DiscIcon } from "@/ui/icons";
import { useServer } from "../../builtins/server/serverStore";
import { remoteId } from "../_remoteSource/logic";
import { RemoteSourcePage } from "../_remoteSource/RemoteSourcePage";
import { S3Settings } from "./S3Settings";
import { S3_PREFIX, useS3 } from "./store";

let watchingServer = false;

/** S3 follows the Cadence account: look it up on sign-in, forget it on sign-out. */
function followServerAccount() {
  if (watchingServer) return;
  watchingServer = true;
  useServer.subscribe((state, prev) => {
    if (state.user?.username === prev.user?.username) return;
    if (state.user) void useS3.getState().refresh();
    else useS3.getState().reset();
  });
}

/** Music in an S3-compatible bucket (AWS, MinIO, Backblaze B2, Cloudflare R2), indexed and streamed through your Cadence server. */
const s3Plugin: Plugin = {
  manifest: {
    id: "cadence.s3",
    name: "S3-compatible storage (AWS, MinIO, B2, R2)",
    version: "1.0.0",
    description:
      "Play music stored in an S3-compatible bucket: Amazon S3, MinIO, Backblaze B2, Cloudflare R2 and others. Your Cadence server lists the folders you pick and streams the files, so this device never sees the access key. The server owner must turn the plugin on at the server too.",
    author: "Cadence",
    capabilities: ["source.audio", "source.library", "ui.sidebar", "ui.settings", "network.outbound"],
    apiRange: "^1.0.0",
  },
  activate(ctx) {
    followServerAccount();
    if (useServer.getState().user) void useS3.getState().refresh();

    ctx.registerSettingsPanel({
      id: "s3",
      title: "S3 storage",
      description: "Music in an Amazon S3, MinIO, Backblaze B2 or Cloudflare R2 bucket.",
      icon: <DiscIcon size={19} />,
      keywords: ["aws", "bucket", "minio", "backblaze", "b2", "cloudflare", "r2", "object storage", "cloud"],
      render: () => <S3Settings />,
    });
    ctx.registerSidebarItem({
      id: "s3",
      label: "S3 storage",
      icon: <DiscIcon />,
      render: () => (
        <RemoteSourcePage
          store={useS3}
          title="S3 storage"
          label="S3 storage"
          settingsId="s3"
          intro="Music from your S3-compatible bucket, played through your Cadence server."
        />
      ),
    });
    ctx.registerLibrarySource({ id: "s3", label: "S3 storage", useTracks: () => useS3((s) => s.tracks) });
    ctx.registerAudioSource({
      id: "s3",
      label: "S3 storage",
      async resolve(track) {
        const id = remoteId(track, S3_PREFIX);
        if (!id || !useServer.getState().token) return null;
        return useS3.getState().streamUrl(id);
      },
    });
  },
};

export default s3Plugin;
