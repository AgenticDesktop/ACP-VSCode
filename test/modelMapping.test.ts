import { test } from "node:test";
import assert from "node:assert/strict";
import { mapAcpModelsToInfo } from "../src/provider/modelMapping";
import type { AcpModelInput } from "../src/provider/modelMapping";

test("1) mapAcpModelsToInfo maps ACP model fields onto picker entries", () => {
  const models = mapAcpModelsToInfo("gemini", [
    { modelId: "mock-fast", name: "Mock Fast" },
    { modelId: "mock-smart", name: "Mock Smart", description: "Slower but smarter" },
  ]);

  assert.equal(models.length, 2);

  const [fast, smart] = models;
  assert.equal(fast.id, "mock-fast");
  assert.equal(fast.name, "Mock Fast");
  assert.equal(fast.family, "acp-gemini");
  assert.equal(fast.version, "default");
  assert.equal(fast.maxInputTokens, 60_000);
  assert.equal(fast.maxOutputTokens, 8_000);
  assert.deepEqual(fast.capabilities, { toolCalling: true });
  assert.equal(fast.isUserSelectable, true);
  assert.equal(fast.targetChatSessionType, "acp-gemini");
  assert.equal(fast.tooltip, undefined);

  assert.equal(smart.id, "mock-smart");
  assert.equal(smart.tooltip, "Slower but smarter");
});

test("2) mapAcpModelsToInfo dedupes by modelId keeping the first occurrence", () => {
  const models = mapAcpModelsToInfo("codex", [
    { modelId: "dup", name: "First" },
    { modelId: "dup", name: "Second" },
  ]);
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "dup");
  assert.equal(models[0].name, "First");
});

test("3) mapAcpModelsToInfo drops entries with an empty modelId", () => {
  const input: AcpModelInput[] = [
    { modelId: "", name: "Empty" },
    { modelId: "kept", name: "Kept" },
  ];
  const models = mapAcpModelsToInfo("claude", input);
  assert.deepEqual(
    models.map((model) => model.id),
    ["kept"],
  );
});

test("4) mapAcpModelsToInfo returns an empty list for an empty input", () => {
  assert.deepEqual(mapAcpModelsToInfo("qwen", []), []);
});
