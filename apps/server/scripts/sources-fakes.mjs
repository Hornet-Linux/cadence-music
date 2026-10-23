// Starts the test doubles for the WebDAV, S3 and Google/Microsoft source plugins so a real server (for example the
// Docker image) can be tried by hand or by a browser. Build first: `npm run build` in apps/server.
//
//   node scripts/sources-fakes.mjs [publicHost] [davPort] [s3Port] [cloudPort] [altHost]
//
// publicHost is the name the server reaches this machine by (host.docker.internal from a Docker container on
// Windows/macOS; the default is 127.0.0.1). The doubles listen on all interfaces. They are NOT the real services.
import { FakeWebdav } from "../dist/community/webdav/fakeWebdav.js";
import { FakeS3 } from "../dist/community/s3/fakeS3.js";
import { FakeCloud } from "../dist/community/onedrive-gdrive/fakeCloud.js";
import { makeMp3 } from "../dist/sources/testAudio.js";

const [publicHost = "127.0.0.1", davPort = "9251", s3Port = "9252", cloudPort = "9253", altHost = "localhost"] = process.argv.slice(2);
const listen = (port) => ({ host: "0.0.0.0", port: Number(port), publicHost });

const song = (title, artist, album, track, frames = 900) => makeMp3({ title, artist, album, albumArtist: artist, track, frames });

const dav = new FakeWebdav("/dav", "alice", "app-password");
dav
  .add("/Music/Night Owls/After Dark/01 Blue Hour.mp3", song("Blue Hour", "Night Owls", "After Dark", 1))
  .add("/Music/Night Owls/After Dark/02 Moth.mp3", song("Moth", "Night Owls", "After Dark", 2))
  .add("/Music/Night Owls/After Dark/03 Lantern.mp3", song("Lantern", "Night Owls", "After Dark", 3))
  .add("/Music/Solo/Singles/Only Song.mp3", song("Only Song", "Solo", "Singles", 1, 600))
  .add("/Documents/notes.txt", Buffer.from("not music"));
await dav.start(listen(davPort));

const s3 = new FakeS3("music", "AKIAFAKEFAKEFAKE", "fake/secret/key+for+tests", "us-east-1");
s3.add("Rivers/Low Water/01 Current.mp3", song("Current", "Rivers", "Low Water", 1))
  .add("Rivers/Low Water/02 Eddy.mp3", song("Eddy", "Rivers", "Low Water", 2))
  .add("Rivers/Low Water/03 Delta.mp3", song("Delta", "Rivers", "Low Water", 3))
  .add("Loose/Café (live).mp3", song("Café (live)", "Various", "Loose", 1, 600))
  .add("notes.txt", Buffer.from("text"));
s3.pageSize = 2;
await s3.start(listen(s3Port));

const cloud = new FakeCloud();
await cloud.start({ ...listen(cloudPort), altHost }); // altHost: another name for this machine, to test redirects to a different origin
for (const [p, artist, album] of [
  ["google", "Paper Boats", "Harbour Lights"],
  ["microsoft", "Quiet Hours", "Slow Morning"],
]) {
  const music = cloud.folder(p, "Music");
  const dir = cloud.folder(p, album, music);
  [1, 2, 3].forEach((n) => cloud.file(p, `0${n} ${album} part ${n}.mp3`, dir, song(`${album} part ${n}`, artist, album, n)));
  cloud.file(p, "cover.jpg", dir, Buffer.from("jpeg"));
  cloud.folder(p, "Podcasts");
}

console.log(
  JSON.stringify(
    {
      webdav: { url: dav.url, username: "alice", password: "app-password" },
      s3: { endpoint: s3.url, region: "us-east-1", bucket: "music", accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      cloud: { clientId: cloud.clientId, clientSecret: cloud.clientSecret, google: cloud.endpoints("google"), microsoft: cloud.endpoints("microsoft"), url: cloud.url },
    },
    null,
    2,
  ),
);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
