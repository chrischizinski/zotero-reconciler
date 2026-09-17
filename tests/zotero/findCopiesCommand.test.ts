import { describe, expect, it } from "vitest";
import { FindCopiesCommand } from "../../src/zotero/findCopiesCommand.js";
import type { ZoteroItem } from "../../src/zotero/adapter.js";

function selectedItem(): ZoteroItem {
  return {
    libraryID: 1,
    key: "AAAA1111",
    version: 1,
    itemType: "journalArticle",
    isRegularItem: () => true,
    getField: (field) => field === "title" ? "Waterfowl harvest" : "",
    getCreators: () => [{ lastName: "Smith", firstName: "Jane" }]
  };
}

function menuHarness() {
  const elements = new Map<string, FakeElement>();
  const menu = new FakeElement(elements);
  const document = {
    getElementById: (id: string) => id === "zotero-itemmenu" ? menu : elements.get(id) ?? null,
    createXULElement: () => new FakeElement(elements)
  };
  return { document, elements, menu };
}

class FakeElement {
  id = "";
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();

  constructor(private readonly owner?: Map<string, FakeElement>) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }

  appendChild(child: FakeElement): FakeElement {
    if (child.id) this.owner?.set(child.id, child);
    return child;
  }

  remove(): void {
    if (this.id) this.owner?.delete(this.id);
  }
}

describe("Find Copies command", () => {
  it("registers once and removes its item-menu entry during shutdown", () => {
    const harness = menuHarness();
    const command = new FindCopiesCommand({
      debug: () => undefined,
      getActiveZoteroPane: () => ({ getSelectedItems: () => [] }),
      getMainWindow: () => ({ document: harness.document } as unknown as Window),
      Libraries: { getAll: () => [] },
      Items: { getAll: async () => [] }
    });

    command.register();
    command.register();
    const entry = harness.elements.get("zotero-library-reconciler-find-copies");
    expect(entry?.attributes.get("label")).toBe("Find Copies in Other Libraries");
    expect(harness.elements.get("zotero-library-reconciler-audit")?.attributes.get("label")).toBe("Audit Cross-Library Coverage");
    expect(harness.elements).toHaveLength(2);

    command.unregister();
    expect(harness.elements).toHaveLength(0);
  });

  it("shows an explicit selection instruction instead of scanning an ambiguous selection", async () => {
    const harness = menuHarness();
    const alerts: string[] = [];
    const command = new FindCopiesCommand({
      debug: () => undefined,
      getActiveZoteroPane: () => ({ getSelectedItems: () => [selectedItem(), selectedItem()] }),
      getMainWindow: () => ({ document: harness.document, alert: (message: string) => alerts.push(message) } as unknown as Window),
      Libraries: { getAll: () => [] },
      Items: { getAll: async () => [] }
    });

    await command.run();
    expect(alerts).toEqual(["Select one bibliographic item, then choose Find Copies in Other Libraries."]);
  });
});
