import { test, expect } from "../../fixtures";
import { addMember, createBoard, listBoards } from "../../support/api";
import { Rail } from "../../support/rail";

// Rail order and pinning on a mindmap two people can both see.
//
// `position` and `pinned` are columns on the mindmap itself (worker/src/index.ts
// notes this and TODO.md names the fix: a per-person preferences table). So
// the order is ONE shared value. These specs say what a person would expect,
// and are fixme until it is per person. The first test pins today's behaviour
// where it is already right.

test.describe("rail order on a shared mindmap", () => {
  test("an editor sees the shared mindmaps in their own rail, next to their own", async ({ page, account, request, existing, openAs }) => {
    void account;
    const alpha = await createBoard(request, "Alpha");
    await addMember(request, "boards", alpha.id, existing.user.email, "editor");
    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await expect(new Rail(theirs).names()).toHaveText(["Alpha", "Start here"]);
    void page;
  });

  test.fixme("reordering the rail does not move the mindmaps in the other person's rail", async ({
    page,
    account,
    request,
    existing,
    openAs,
  }) => {
    // Expected: each person's drag-to-reorder is their own. Actual: the drag
    // posts the whole visible order to /api/boards/reorder, which writes
    // `boards.position` — a column both people read — so the owner's rail
    // changes under them. Observed: owner has [Beta, Alpha], editor drags
    // Alpha above Beta, the owner's list (API and rail after a reload) is
    // now [Alpha, Beta].
    void account;
    const alpha = await createBoard(request, "Alpha");
    const beta = await createBoard(request, "Beta");
    await addMember(request, "boards", alpha.id, existing.user.email, "editor");
    await addMember(request, "boards", beta.id, existing.user.email, "editor");
    expect((await listBoards(request)).map((b) => b.name).slice(0, 2)).toEqual(["Beta", "Alpha"]);

    const theirs = await openAs(existing);
    await theirs.goto("/app");
    const rail = new Rail(theirs);
    await expect(rail.names()).toHaveText(["Beta", "Alpha", "Start here"]);
    const reordered = theirs.waitForResponse((r) => r.url().endsWith("/api/boards/reorder") && r.ok());
    await rail.row("Alpha").dragTo(rail.row("Beta"));
    await reordered;
    await expect(rail.names()).toHaveText(["Alpha", "Beta", "Start here"]);

    await page.goto("/app");
    await expect(new Rail(page).names()).toHaveText(["Beta", "Alpha", "Start here"]);
    expect((await listBoards(request)).map((b) => b.name).slice(0, 2)).toEqual(["Beta", "Alpha"]);
  });

  test.fixme("pinning a mindmap pins it for you only", async ({ page, account, request, existing, openAs }) => {
    // Expected: the owner's pin is the owner's preference; the person it is
    // shared with sees their rail unchanged. Actual: `boards.pinned` is shared,
    // so the owner's pin floats the mindmap to the top of the other person's rail
    // as well (and an editor cannot pin or unpin it at all: 403 "Only the owner
    // can do that").
    void account;
    const alpha = await createBoard(request, "Alpha");
    const beta = await createBoard(request, "Beta"); // newer, so first until Alpha is pinned
    await addMember(request, "boards", alpha.id, existing.user.email, "editor");
    await addMember(request, "boards", beta.id, existing.user.email, "editor");

    await page.goto("/app");
    const mine = new Rail(page);
    const pinned = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/boards/${alpha.id}`) && r.ok());
    await mine.row("Alpha").getByRole("button", { name: "Pin to top" }).click();
    await pinned;

    const theirs = await openAs(existing);
    await theirs.goto("/app");
    await expect(new Rail(theirs).row("Alpha").getByRole("button", { name: /Pin to top|Unpin/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(new Rail(theirs).names()).toHaveText(["Beta", "Alpha", "Start here"]);
  });
});
