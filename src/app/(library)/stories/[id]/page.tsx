import { notFound } from "next/navigation";
import { pageCtx } from "@/lib/server/auth";
import { getBook, getStory, listPages } from "@/lib/server/db";
import { appStatus } from "@/lib/server/config";
import { artBusy, drawnBeforeUrls, resumeLostArt } from "@/lib/server/art";
import { planCostGuess } from "@/lib/server/prices";
import { pictureSpendForStory, writeCosts } from "@/lib/server/spending";
import { picturePace } from "@/lib/server/timing";
import { Studio } from "./Studio";

export default async function StoryPage(props: PageProps<"/stories/[id]">) {
  const { id } = await props.params;
  const ctx = await pageCtx();
  let story = getStory(ctx.household.id, id);
  if (!story) notFound();
  if (story.art && story.art.status !== "idle" && !artBusy(id)) {
    resumeLostArt(id);
    story = getStory(ctx.household.id, id)!;
  }
  const book = getBook(ctx.household.id, story.bookId)!;
  const words = (story.script?.pages ?? []).reduce((n, p) => n + p.lines.reduce((m, l) => m + l.text.split(/\s+/).length, 0), 0);
  return (
    <main className="page page-narrow">
      <Studio
        initial={story}
        book={book}
        photos={listPages(book.id)}
        status={{ ...appStatus(), pace: picturePace() }}
        pictureSpend={pictureSpendForStory(id)}
        drawnBefore={drawnBeforeUrls(ctx.household.id, id)}
        planPrice={planCostGuess(words, story.script?.pages.length ?? 6)}
        writeCost={writeCosts(ctx.household.id)[story.settings.length]}
      />
    </main>
  );
}

export async function generateMetadata(props: PageProps<"/stories/[id]">) {
  const { id } = await props.params;
  const ctx = await pageCtx();
  return { title: getStory(ctx.household.id, id)?.title ?? "Story" };
}
