import { driveLink } from "@/lib/shared/drive";
import { MAX_BYTES } from "./audio";
import { mp4Sound, type Source } from "./videoSound";

// A video or recording kept in Google Drive comes straight from Google to this phone (never through Storyhollow),
// to have its sound taken out like any other. With only a key and no sign-in, Google hands over files shared with
// "Anyone with the link". From an MP4 or a MOV only the sound is fetched, a piece at a time.

const API = "https://www.googleapis.com/drive/v3/files";
const TOO_BIG = "That video is too big to open on a phone. Save it to your phone, trim it to the part where they're speaking (in Photos, tap Edit and drag the ends in), then choose it from there.";

/** What a file that isn't a video or a recording is, in a word or two. */
function kindOf(type: string): string {
  if (type === "application/vnd.google-apps.folder") return "a folder";
  if (type.startsWith("application/vnd.google-apps.")) return "a Google Doc or Sheet";
  if (type.startsWith("image/")) return "a photo";
  if (type === "application/pdf") return "a PDF";
  return "a file";
}

/** Why Google said no, in the family's words. */
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; details?: { reason?: string }[] } };
  const reasons = [...(body.error?.errors ?? []), ...(body.error?.details ?? [])].map((e) => e.reason ?? "");
  if (res.status === 404) {
    return "That video is private, so only its owner can open it. In Google Drive, tap Share, set General access to “Anyone with the link”, then paste the link again. You can make it private again afterwards.";
  }
  if (reasons.some((r) => /quota|rateLimit/i.test(r))) {
    return "Google says that video has been downloaded a lot today. Try again later, or save it to your phone and choose it from there.";
  }
  if (reasons.includes("cannotDownloadAbusiveFile")) return "Google won't hand that file over. Save it to your phone and choose it from there.";
  if (res.status === 400 || res.status === 403) {
    return "Google Drive links aren't set up quite right yet: a grown-up needs to check the Google key (see “Videos from Google Drive” in the setup notes).";
  }
  return `Google Drive couldn't send it just now (${res.status}). Try again, or save the video to your phone and choose it from there.`;
}

/** A video or recording shared from Google Drive, fetched to this phone. `onProgress` hears how much has come. */
export async function fetchFromDrive(link: string, key: string, onProgress?: (fraction: number) => void): Promise<File> {
  const file = driveLink(link);
  if (!file) throw new Error("That doesn't look like a Google Drive link. In Drive, open the video, tap Share, then Copy link, and paste it here.");
  if ("folder" in file) throw new Error("That's a link to a folder. Open the video itself in Drive, copy its link, and paste that.");
  // Some links shared before 2021 carry a key of their own, which Google wants to see again.
  const headers: Record<string, string> = file.resourceKey ? { "X-Goog-Drive-Resource-Keys": `${file.id}/${file.resourceKey}` } : {};
  const ask = async (query: string, more: Record<string, string> = {}) => {
    try {
      return await fetch(`${API}/${encodeURIComponent(file.id)}?${query}&supportsAllDrives=true&key=${encodeURIComponent(key)}`, {
        headers: { ...headers, ...more },
      });
    } catch {
      throw new Error("Google Drive couldn't be reached. Check the signal and try again.");
    }
  };

  const about = await ask("fields=name,mimeType,size");
  if (!about.ok) throw new Error(await refusal(about));
  const meta = (await about.json()) as { name?: string; mimeType?: string; size?: string };
  const type = meta.mimeType ?? "";
  if (!type.startsWith("video/") && !type.startsWith("audio/")) throw new Error(`That link is to ${kindOf(type)}, not a video or a recording.`);
  const size = Number(meta.size ?? 0);
  const name = meta.name || "From Google Drive";

  // Just the sound of a video, read a piece at a time: far less to fetch, and however big the video is. If Google
  // won't send it in pieces, or it isn't that kind of video, it comes whole, as before.
  if (size) {
    const pieces: Source = {
      size,
      // Only the sound: the picture between its pieces is passed over, however little of it there is.
      near: 64 * 1024,
      together: 12,
      read: async (from, to) => {
        const res = await ask("alt=media", { Range: `bytes=${from}-${to - 1}` });
        if (res.status !== 206) {
          await res.body?.cancel();
          throw new Error(`Google answered ${res.status}, not a piece`);
        }
        return res.arrayBuffer();
      },
    };
    const found = await mp4Sound(pieces).catch(() => null);
    if (found === "silent") throw new Error("That video has no sound in it. Choose one where you can hear them speaking.");
    const sound = found && (await found.read(undefined, onProgress).catch(() => null));
    if (sound) return new File([sound], `${name.replace(/\.\w+$/, "")}.m4a`, { type: "audio/mp4" });
  }

  if (size > MAX_BYTES) throw new Error(TOO_BIG);
  const media = await ask("alt=media");
  if (!media.ok) throw new Error(await refusal(media));
  if (!media.body) return new File([await media.blob()], name, { type });
  const reader = media.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (got > MAX_BYTES) {
      await reader.cancel();
      throw new Error(TOO_BIG);
    }
    if (size) onProgress?.(Math.min(1, got / size));
  }
  return new File(chunks, name, { type });
}
