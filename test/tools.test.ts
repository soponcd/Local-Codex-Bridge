import assert from "node:assert/strict";
import test from "node:test";

import { AppServerManager } from "../src/app-server.js";
import { RuntimeStore } from "../src/runtime.js";
import { ControlSurface, TOOL_DEFINITIONS } from "../src/tools.js";
import {
  DARWIN_PLATFORM_POLICY,
  WINDOWS_PLATFORM_POLICY,
} from "../src/platform.js";

interface CapturedRequest {
  method: string;
  params: unknown;
}

class StubAppServerManager extends AppServerManager {
  readonly requests: CapturedRequest[] = [];

  constructor(
    private readonly handleRequest: (method: string, params: unknown) => unknown,
  ) {
    super(new RuntimeStore(), { executable: "unused-test-codex" });
  }

  override async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return this.handleRequest(method, params);
  }
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function propertySchema(toolName: string, propertyName: string): Record<string, unknown> {
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === toolName);
  assert.ok(tool, `missing tool definition ${toolName}`);
  const properties = object(tool.inputSchema.properties);
  return object(properties[propertyName]);
}

test("resume excludes hydrated turns and errors never retry without excludeTurns", async () => {
  for (const fail of [false, true]) {
    const manager = new StubAppServerManager((method, params) => {
      if (method === "thread/resume") {
        assert.deepEqual(params, { threadId: "thread-resume", excludeTurns: true });
        if (fail) throw new Error("native resume rejected");
        return { thread: { id: "thread-resume", turns: [] } };
      }
      if (method === "turn/start") return { turn: { id: "turn-next", status: "inProgress" } };
      throw new Error(`unexpected ${method}`);
    });
    const result = new ControlSurface(manager).call("codex_turn", { thread_id: "thread-resume", text: "continue" });
    if (fail) await assert.rejects(result, /native resume rejected/);
    else await result;
    assert.deepEqual(manager.requests.map(request => request.method), fail ? ["thread/resume"] : ["thread/resume", "turn/start"]);
  }
});

test("codex_turn forwards each requested raw sandbox and the exact returned native policy", async (t) => {
  const cases = [
    {
      requested: "read-only",
      policy: { type: "readOnly" },
    },
    {
      requested: "workspace-write",
      policy: {
        type: "workspaceWrite",
        writableRoots: ["D:\\work", "D:\\shared"],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: true,
      },
    },
    {
      requested: "danger-full-access",
      policy: { type: "dangerFullAccess" },
    },
  ] as const;

  for (const { requested, policy } of cases) {
    await t.test(requested, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method === "thread/start") {
          return { thread: { id: `thread-${requested}` }, sandbox: policy };
        }
        if (method === "turn/start") {
          return { turn: { id: `turn-${requested}`, status: "inProgress" } };
        }
        throw new Error(`unexpected request ${method}`);
      });
      const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

      await surface.call("codex_turn", {
        text: "test turn",
        cwd: "D:\\work",
        sandbox: requested,
      });

      assert.equal(manager.requests.length, 2);
      assert.equal(manager.requests[0]?.method, "thread/start");
      assert.deepEqual(object(manager.requests[0]?.params), {
        cwd: "D:\\work",
        sandbox: requested,
        serviceName: "local-codex-bridge",
      });
      assert.equal(manager.requests[1]?.method, "turn/start");
      const turnParams = object(manager.requests[1]?.params);
      assert.strictEqual(turnParams.sandboxPolicy, policy);
      assert.deepEqual(turnParams.sandboxPolicy, policy);
    });
  }
});

test("codex_turn uses the newly resolved policy when the same thread changes sandbox", async () => {
  const workspacePolicy = {
    type: "workspaceWrite",
    writableRoots: ["D:\\work"],
    networkAccess: false,
  };
  const readOnlyPolicy = { type: "readOnly" };
  let turnNumber = 0;
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/start") {
      return { thread: { id: "thread-shared" }, sandbox: workspacePolicy };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-shared" }, sandbox: readOnlyPolicy };
    }
    if (method === "turn/start") {
      turnNumber += 1;
      return { turn: { id: `turn-${turnNumber}`, status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "first",
    cwd: "D:\\work",
    sandbox: "workspace-write",
  });
  await surface.call("codex_turn", {
    text: "second",
    thread_id: "thread-shared",
    sandbox: "read-only",
  });

  assert.deepEqual(manager.requests.map((request) => request.method), [
    "thread/start",
    "turn/start",
    "thread/resume",
    "turn/start",
  ]);
  assert.strictEqual(object(manager.requests[1]?.params).sandboxPolicy, workspacePolicy);
  assert.deepEqual(object(manager.requests[2]?.params), {
    threadId: "thread-shared",
    excludeTurns: true,
    sandbox: "read-only",
  });
  assert.strictEqual(object(manager.requests[3]?.params).sandboxPolicy, readOnlyPolicy);
});

test("codex_turn omission requires no effective sandbox or approval-policy readback", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/start") {
      return {
        thread: { id: "thread-default" },
        sandbox: { type: "workspaceWrite", writableRoots: ["D:\\work"] },
      };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-default", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", { text: "default sandbox", cwd: "D:\\work" });

  assert.deepEqual(manager.requests.map((request) => request.method), ["thread/start", "turn/start"]);
  assert.equal("sandbox" in object(manager.requests[0]?.params), false);
  assert.equal("approvalPolicy" in object(manager.requests[0]?.params), false);
  assert.equal("sandboxPolicy" in object(manager.requests[1]?.params), false);
  assert.equal("approvalPolicy" in object(manager.requests[1]?.params), false);
});

test("codex_turn verifies and forwards matching native effective approval policies", async (t) => {
  const approvalPolicies = ["untrusted", "on-request", "never"] as const;

  for (const approvalPolicy of approvalPolicies) {
    await t.test(approvalPolicy, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method === "thread/start") {
          return {
            thread: { id: `thread-${approvalPolicy}` },
            approvalPolicy,
          };
        }
        if (method === "turn/start") {
          return { turn: { id: `turn-${approvalPolicy}`, status: "inProgress" } };
        }
        throw new Error(`unexpected request ${method}`);
      });
      const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

      await surface.call("codex_turn", {
        text: "explicit approval policy",
        cwd: "D:\\work",
        approval_policy: approvalPolicy,
      });

      assert.deepEqual(manager.requests.map((request) => request.method), [
        "thread/start",
        "turn/start",
      ]);
      assert.equal(object(manager.requests[0]?.params).approvalPolicy, approvalPolicy);
      assert.equal(object(manager.requests[1]?.params).approvalPolicy, approvalPolicy);
    });
  }
});

test("codex_turn verifies the effective approval policy returned by thread/resume", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/resume") {
      return { thread: { id: "thread-existing-approval" }, approvalPolicy: "never" };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-existing-approval", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "explicit resumed approval policy",
    thread_id: "thread-existing-approval",
    approval_policy: "never",
  });

  assert.deepEqual(manager.requests.map((request) => request.method), [
    "thread/resume",
    "turn/start",
  ]);
  assert.equal(object(manager.requests[0]?.params).approvalPolicy, "never");
  assert.equal(object(manager.requests[1]?.params).approvalPolicy, "never");
});

test("codex_turn fails before turn/start for unusable or mismatched effective approval policies", async (t) => {
  const invalidPolicies: Array<{
    name: string;
    includeApprovalPolicy: boolean;
    value?: unknown;
  }> = [
    { name: "missing", includeApprovalPolicy: false },
    { name: "non-string", includeApprovalPolicy: true, value: 17 },
    {
      name: "granular object",
      includeApprovalPolicy: true,
      value: { granular: { commandExecution: "on-request" } },
    },
    { name: "compatibility alias", includeApprovalPolicy: true, value: "on-failure" },
    { name: "unrecognized", includeApprovalPolicy: true, value: "future-policy" },
    { name: "mismatched", includeApprovalPolicy: true, value: "on-request" },
  ];

  for (const invalid of invalidPolicies) {
    await t.test(invalid.name, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method !== "thread/start") {
          throw new Error(`unexpected request ${method}`);
        }
        return {
          thread: { id: "thread-invalid-approval" },
          ...(invalid.includeApprovalPolicy ? { approvalPolicy: invalid.value } : {}),
        };
      });
      const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

      await assert.rejects(
        surface.call("codex_turn", {
          text: "must not start",
          cwd: "D:\\work",
          approval_policy: "never",
        }),
        /approvalPolicy/,
      );
      assert.deepEqual(manager.requests.map((request) => request.method), ["thread/start"]);
    });
  }
});

test("codex_turn fails closed before turn/start for unusable returned sandbox policies", async (t) => {
  const invalidPolicies: Array<{ name: string; includeSandbox: boolean; value?: unknown }> = [
    { name: "missing", includeSandbox: false },
    { name: "non-object", includeSandbox: true, value: "workspaceWrite" },
    { name: "array", includeSandbox: true, value: [{ type: "workspaceWrite" }] },
    { name: "missing discriminator", includeSandbox: true, value: {} },
    { name: "unknown discriminator", includeSandbox: true, value: { type: "futurePolicy" } },
    { name: "mismatched discriminator", includeSandbox: true, value: { type: "readOnly" } },
  ];

  for (const invalid of invalidPolicies) {
    await t.test(invalid.name, async () => {
      const manager = new StubAppServerManager((method) => {
        if (method !== "thread/start") {
          throw new Error(`unexpected request ${method}`);
        }
        return {
          thread: { id: "thread-invalid" },
          ...(invalid.includeSandbox ? { sandbox: invalid.value } : {}),
        };
      });
      const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

      await assert.rejects(
        surface.call("codex_turn", {
          text: "must not start",
          cwd: "D:\\work",
          sandbox: "workspace-write",
        }),
        /sandbox/,
      );
      assert.deepEqual(manager.requests.map((request) => request.method), ["thread/start"]);
    });
  }
});

test("codex_models maps one bounded native page and preserves sanitized future fields", async () => {
  const manager = new StubAppServerManager((method) => {
    assert.equal(method, "model/list");
    return {
      data: [{
        id: "model-id",
        model: "model-native",
        displayName: "Model Display",
        hidden: false,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        upgrade: "upgrade-id",
        upgradeInfo: { message: "Upgrade available" },
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        isDefault: true,
        futureCapability: { mode: "preserved" },
      }],
      nextCursor: "next-opaque",
    };
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  const result = object(await surface.call("codex_models", {
    limit: 3,
    cursor: "current-opaque",
    include_hidden: true,
  }));

  assert.deepEqual(manager.requests, [{
    method: "model/list",
    params: { limit: 3, includeHidden: true, cursor: "current-opaque" },
  }]);
  assert.equal(result.source, "codex_app_server_model_list");
  assert.equal(result.nextCursor, "next-opaque");
  const entries = result.data as Array<Record<string, unknown>>;
  assert.equal(entries[0]?.model, "model-native");
  assert.deepEqual(entries[0]?.futureCapability, { mode: "preserved" });
});

test("ordinary codex_turn continuation omits model and effort without listing models", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/resume") {
      return { thread: { id: "thread-existing" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-existing", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", { text: "continue", thread_id: "thread-existing" });

  assert.deepEqual(manager.requests.map((request) => request.method), ["thread/resume", "turn/start"]);
  for (const request of manager.requests) {
    const params = object(request.params);
    assert.equal("model" in params, false);
    assert.equal("effort" in params, false);
  }
});

test("explicit hidden model is found through cycle-safe pagination and passed through unchanged", async () => {
  const manager = new StubAppServerManager((method, params) => {
    if (method === "model/list") {
      return object(params).cursor === undefined
        ? { data: [{ id: "visible", model: "visible-native", hidden: false }], nextCursor: "page-2" }
        : { data: [{ id: "hidden-id", model: "hidden-native", hidden: true }], nextCursor: null };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-hidden" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-hidden", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "hidden model",
    thread_id: "thread-hidden",
    model: "hidden-id",
  });

  assert.deepEqual(manager.requests.map((request) => request.method), [
    "model/list",
    "model/list",
    "thread/resume",
    "turn/start",
  ]);
  assert.deepEqual(object(manager.requests[0]?.params), { limit: 100, includeHidden: true });
  assert.deepEqual(object(manager.requests[1]?.params), {
    limit: 100,
    includeHidden: true,
    cursor: "page-2",
  });
  assert.equal(object(manager.requests[2]?.params).model, "hidden-id");
  assert.equal(object(manager.requests[3]?.params).model, "hidden-id");
});

test("explicit model overrides reject unknown models before thread mutation", async () => {
  const manager = new StubAppServerManager((method) => {
    assert.equal(method, "model/list");
    return { data: [{ id: "known", model: "known-native" }], nextCursor: null };
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await assert.rejects(
    surface.call("codex_turn", {
      text: "unknown model",
      thread_id: "thread-known",
      model: "missing",
    }),
    /Unknown model override "missing"/,
  );
  assert.deepEqual(manager.requests.map((request) => request.method), ["model/list"]);
});

test("model plus effort validates advertised support and passes exact tokens", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "model/list") {
      return {
        data: [{
          id: "reasoning-model",
          model: "reasoning-native",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "high", description: "Deep" },
          ],
        }],
        nextCursor: null,
      };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-reasoning" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-reasoning", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "supported effort",
    thread_id: "thread-reasoning",
    model: "reasoning-native",
    effort: "high",
  });

  assert.equal(object(manager.requests[1]?.params).model, "reasoning-native");
  assert.equal(object(manager.requests[2]?.params).model, "reasoning-native");
  assert.equal(object(manager.requests[2]?.params).effort, "high");
});

test("model plus effort rejects unsupported advertised effort but tolerates absent support data", async (t) => {
  await t.test("advertised unsupported", async () => {
    const manager = new StubAppServerManager((method) => {
      assert.equal(method, "model/list");
      return {
        data: [{
          id: "bounded-model",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
        }],
        nextCursor: null,
      };
    });
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await assert.rejects(
      surface.call("codex_turn", {
        text: "unsupported effort",
        thread_id: "thread-bounded",
        model: "bounded-model",
        effort: "high",
      }),
      /Unsupported effort "high" for model "bounded-model".*medium/,
    );
    assert.deepEqual(manager.requests.map((request) => request.method), ["model/list"]);
  });

  await t.test("support field absent", async () => {
    const manager = new StubAppServerManager((method) => {
      if (method === "model/list") {
        return { data: [{ id: "native-authoritative" }], nextCursor: null };
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-native" } };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-native", status: "inProgress" } };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await surface.call("codex_turn", {
      text: "native decides",
      thread_id: "thread-native",
      model: "native-authoritative",
      effort: "future-effort",
    });
    assert.equal(object(manager.requests[2]?.params).effort, "future-effort");
  });
});

test("effort-only validation uses the catalog-wide advertised union without inferring a model", async (t) => {
  await t.test("advertised somewhere passes through", async () => {
    const manager = new StubAppServerManager((method) => {
      if (method === "model/list") {
        return {
          data: [
            { id: "model-a", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
            { id: "model-b", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] },
          ],
          nextCursor: null,
        };
      }
      if (method === "thread/resume") {
        return { thread: { id: "thread-effort" } };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn-effort", status: "inProgress" } };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await surface.call("codex_turn", {
      text: "effort only",
      thread_id: "thread-effort",
      effort: "xhigh",
    });
    assert.equal("model" in object(manager.requests[1]?.params), false);
    assert.equal("model" in object(manager.requests[2]?.params), false);
    assert.equal(object(manager.requests[2]?.params).effort, "xhigh");
  });

  await t.test("absent everywhere rejects before mutation", async () => {
    const manager = new StubAppServerManager((method) => {
      assert.equal(method, "model/list");
      return {
        data: [{ id: "model-only", supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
        ] }],
        nextCursor: null,
      };
    });
    const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);
    await assert.rejects(
      surface.call("codex_turn", {
        text: "unknown effort",
        thread_id: "thread-effort",
        effort: "impossible",
      }),
      /absent from all advertised supportedReasoningEfforts.*does not infer the current thread model.*low, medium/,
    );
    assert.deepEqual(manager.requests.map((request) => request.method), ["model/list"]);
  });
});

test("model catalog pagination cycles fail locally before thread mutation", async () => {
  let page = 0;
  const manager = new StubAppServerManager((method) => {
    assert.equal(method, "model/list");
    page += 1;
    return {
      data: [{ id: `other-${page}` }],
      nextCursor: "repeat-cursor",
    };
  });
  const surface = new ControlSurface(manager, undefined, WINDOWS_PLATFORM_POLICY);

  await assert.rejects(
    surface.call("codex_turn", {
      text: "cycle",
      thread_id: "thread-cycle",
      model: "missing",
    }),
    /pagination cursor cycle detected/,
  );
  assert.deepEqual(manager.requests.map((request) => request.method), ["model/list", "model/list"]);
});

test("public tool schemas expose the same string bounds already enforced at runtime", () => {
  const expected: Array<[string, string, number]> = [
    ["codex_threads", "thread_id", 200],
    ["codex_threads", "cwd", 1_000],
    ["codex_threads", "cursor", 10_000],
    ["codex_turn", "thread_id", 200],
    ["codex_turn", "cwd", 1_000],
    ["codex_observe", "thread_id", 200],
    ["codex_steer", "thread_id", 200],
    ["codex_steer", "expected_turn_id", 200],
    ["codex_respond", "thread_id", 200],
    ["codex_respond", "turn_id", 200],
    ["codex_respond", "method", 300],
    ["codex_interrupt", "thread_id", 200],
    ["codex_interrupt", "turn_id", 200],
  ];

  for (const [tool, property, maxLength] of expected) {
    assert.equal(
      propertySchema(tool, property).maxLength,
      maxLength,
      `${tool}.${property}`,
    );
  }
});

test("ControlSurface delegates native cwd normalization to the selected policy", async () => {
  const manager = new StubAppServerManager((method) => {
    if (method === "thread/start") {
      return { thread: { id: "thread-darwin" } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-darwin", status: "inProgress" } };
    }
    throw new Error(`unexpected request ${method}`);
  });
  const surface = new ControlSurface(manager, undefined, DARWIN_PLATFORM_POLICY);

  await surface.call("codex_turn", {
    text: "native path",
    cwd: "/Users/example/../bridge",
  });

  assert.equal(object(manager.requests[0]?.params).cwd, "/Users/bridge");
  assert.equal(object(manager.requests[1]?.params).cwd, "/Users/bridge");
  await assert.rejects(
    surface.call("codex_turn", { text: "relative", cwd: "Users/example" }),
    /absolute POSIX path on macOS/,
  );
});
