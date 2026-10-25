// Browser runs: a run types only supplied values and chooses only offered targets, stops with a reason Pi can act on,
// is decided by Jev or the session's model as the owner chose, and its cost goes to the session's spend.
// Run with POCKET_DIR set to a Pi Pocket 0.22.0 (or later) checkout with its packages installed:
//   POCKET_DIR=~/work/pi-pocket node --test browser-runs.test.ts
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import type { BrowserControl, BrowserPageHandle } from "./_pocket.d.ts";
import {
    addressOf,
    type Decider,
    DecisionError,
    type DecisionState,
    JevDecider,
    type Question,
    readAnswers,
    report,
    type RunOptions,
    type RunPage,
    RunModelSetting,
    runGoal,
    runPage,
    SessionDecider,
    validRunModel,
} from "./browser-runs.ts";

const POCKET = resolve(process.env.POCKET_DIR ?? "../pi-pocket");
// Pi Pocket's test helpers first: they point Pi Pocket at a temporary folder before it loads.
const helpers = await import(join(POCKET, "test", "helpers.ts"));
const {
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} = helpers;
const { fauxAssistantMessage, fauxText, fauxToolCall } = await import(
    join(POCKET, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "faux.js")
);
const { UsageDoc } = await import(
    join(POCKET, "node_modules", "@earendil-works", "pi-durable", "dist", "index.js")
);
const { findBrowser } = await import(join(POCKET, "src", "server", "browser", "discovery.ts"));

const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
};

/** A shop: a search box, a sort, a Go button, results after Go, and a password field to leave alone. */
const SHOP = `<!doctype html><html><head><title>Shop</title><meta name="viewport" content="width=device-width"></head><body>
<form onsubmit="event.preventDefault(); const q = document.getElementById('q').value; const sort = document.getElementById('sort').value; document.getElementById('out').textContent = 'Results for ' + q + ' sorted by ' + sort">
<label for="q">Search</label><input id="q" type="search" value="old">
<label for="sort">Sort</label><select id="sort"><option value="best">Best match</option><option value="new">Newest</option></select>
<label for="pw">Password</label><input id="pw" type="password" value="hunter22">
<button type="submit">Go</button><button type="button" disabled>Later</button></form>
<p id="out"></p><div style="height:3000px"></div><a href="/far">Far link</a></body></html>`;

let site: Server;
let base = "";

before(async () => {
    site = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(SHOP);
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => {
    site.close();
    cleanUp();
});

// ─── The run ─────────────────────────────────────────────────────────────────────────────────────────────

/** A page made of controls, whose actions change what it shows: enough to drive the loop without a browser. */
function fakePage(
    controls: BrowserControl[],
    act: (what: string, page: { text: string; controls: BrowserControl[] }) => void,
) {
    const state = { text: "A shop", controls: structuredClone(controls) };
    const done: string[] = [];
    const page: RunPage = {
        observe: async () => ({
            url: "https://shop.test/",
            title: "Shop",
            text: state.text,
            controls: structuredClone(state.controls),
            below: false,
            above: false,
        }),
        click: async (ref) => {
            done.push(`click ${ref}`);
            act(`click ${ref}`, state);
        },
        type: async (ref, value) => {
            done.push(`type ${ref} ${value}`);
            act(`type ${ref} ${value}`, state);
        },
        select: async (ref, option) => {
            done.push(`select ${ref} ${option}`);
            act(`select ${ref} ${option}`, state);
        },
        scroll: async () => {
            done.push("scroll");
        },
        wait: async () => {
            done.push("wait");
        },
        stale: () => false,
    };

    return { page, done, state };
}

/** A run model that answers from a script, one step after another, and records what it was offered. */
function scripted(steps: Record<string, { choice?: string; noul?: number }>[]) {
    const asked: { state: DecisionState; questions: Record<string, Question> }[] = [];
    const decider: Decider = {
        label: "scripted",
        decide: async (state, questions) => {
            asked.push({ state, questions });
            const step = steps[asked.length - 1];

            if (step === undefined) {
                throw new DecisionError("no more steps");
            }

            return {
                answers: readAnswers(questions, step),
                spent: { cost: 0.0001, input: 100, output: 10 },
            };
        },
    };

    return { decider, asked };
}

const control = (
    fields: Partial<BrowserControl> & Pick<BrowserControl, "ref" | "role" | "name" | "kind">,
) => ({ disabled: false, inView: true, ...fields }) as BrowserControl;

/** As Pi Pocket 0.22.0's snapshot gives them. */
const SHOP_CONTROLS: BrowserControl[] = [
    control({ ref: "e1", role: "searchbox", name: "Search", kind: "search", value: "old" }),
    control({
        ref: "e2",
        role: "combobox",
        name: "Sort",
        kind: "select",
        value: "Best match",
        options: ["Best match", "Newest"],
    }),
    control({ ref: "e3", role: "textbox", name: "Password", kind: "password", value: "••••" }),
    control({ ref: "e4", role: "button", name: "Go", kind: "button" }),
    control({ ref: "e5", role: "button", name: "Later", kind: "button", disabled: true }),
    control({ ref: "e6", role: "link", name: "Far link", kind: "a", inView: false }),
];

const options = (
    values: Record<string, string> = {},
    more: Partial<RunOptions> = {},
): RunOptions => ({
    goal: "Search for lamps, sorted by newest",
    values,
    maxSteps: 25,
    timeMs: 60_000,
    progress: () => {},
    ...more,
});

test("a run types only supplied values, chooses only offered targets, and is done when the page shows it", async () => {
    const { page, done, state } = fakePage(SHOP_CONTROLS, (what, page) => {
        if (what === "click e4") {
            page.text = "Results for lamp sorted by new";
        }

        if (what.startsWith("type e1")) {
            page.controls[0]!.value = what.slice("type e1 ".length);
        }
    });
    const step = (
        operation: string,
        more: Record<string, { choice?: string; noul?: number }> = {},
    ) => ({
        operation: { choice: operation },
        type_text_target: { choice: "1" },
        value_for_field: { choice: "none" },
        click_target: { choice: "3" },
        select_target: { choice: "2:2" },
        goal_achieved: { noul: 0 },
        ...more,
    });
    const { decider, asked } = scripted([
        step("TYPE_TEXT", { value_for_field: { choice: "query" } }),
        step("SELECT", { prev_ok: { noul: 1 } }),
        step("CLICK", { prev_ok: { noul: 1 }, goal_achieved: { noul: 0.2 } }),
        step("DONE", { prev_ok: { noul: 1 }, goal_achieved: { noul: 0.9 } }),
    ]);
    const result = await runGoal(page, decider, options({ query: "lamp" }));

    assert.equal(result.status, "done");
    assert.deepEqual(done, ["type e1 lamp", "select e2 Newest", "click e4"]);
    assert.equal(result.decisions, 4);
    assert.ok(Math.abs(result.spent.cost - 0.0004) < 1e-9);

    // Offered: the search, the sort's options, and Go; not the password, a disabled button, or what is out of view.
    const first = asked[0]!;

    assert.deepEqual(
        first.state.elements.map((each) => each.label),
        ["Search", "Sort", "Go"],
    );
    assert.deepEqual(Object.keys(first.questions.type_text_target!.criteria), ["1"]);
    assert.deepEqual(Object.keys(first.questions.select_target!.criteria), ["2:1", "2:2"]);
    assert.deepEqual(Object.keys(first.questions.value_for_field!.criteria), ["query", "none"]);
    assert.equal(first.questions.prev_ok, undefined, "nothing to judge before the first step");
    assert.match(
        asked[3]!.state.recent_actions.map((each) => each.action).join("; "),
        /typed query into \[e1\] Search/,
    );
    assert.equal(state.text, "Results for lamp sorted by new");

    const told = report(result, "scripted", "the page");

    assert.match(told, /^Done in 3 steps\. [\d.]+ s, 4 decisions by scripted, \$0\.00040\./);
    assert.match(
        told,
        /1\. typed query into \[e1\] Search\n2\. chose "Newest" in \[e2\] Sort\n3\. clicked \[e4\] Go/,
    );
});

test("a run stops with a reason Pi can act on", async () => {
    const step = (operation: string, achieved = 0, value = "none") => ({
        operation: { choice: operation },
        type_text_target: { choice: "1" },
        value_for_field: { choice: value },
        click_target: { choice: "3" },
        select_target: { choice: "2:1" },
        prev_ok: { noul: 0 },
        goal_achieved: { noul: achieved },
    });
    const stopped = async (
        steps: ReturnType<typeof step>[],
        more: Partial<RunOptions> = {},
        values = {},
    ) => {
        const { page } = fakePage(SHOP_CONTROLS, () => {});
        const { decider } = scripted(steps);

        return runGoal(page, decider, options(values, more));
    };

    assert.equal((await stopped([step("DONE", 0.3)])).reason, "unverified_done");
    assert.equal((await stopped([step("BLOCKED")])).reason, "blocked");
    assert.equal(
        (await stopped([step("TYPE_TEXT")])).reason,
        "needs_value",
        "no value is invented",
    );
    assert.equal(
        (await stopped([step("TYPE_TEXT", 0, "query")], {}, { other: "x" })).reason,
        "decision_error",
        "a value that was not supplied is not an offered choice",
    );
    assert.equal(
        (await stopped([step("CLICK"), step("CLICK"), step("CLICK")])).reason,
        "stuck_loop",
    );
    assert.equal((await stopped([step("WAIT"), step("WAIT")], { maxSteps: 2 })).reason, "budget");
    assert.equal(
        (await stopped([step("CLICK")], { heldBack: () => "The session reached its spend limit." }))
            .reason,
        "spend_limit",
    );

    const refused = await stopped([{ ...step("CLICK"), click_target: { choice: "9" } }]);

    assert.equal(refused.reason, "decision_error");
    assert.match(refused.detail ?? "", /chose "9" for click_target, which was not offered/);
});

test("the page offers scrolling down until a scroll changes nothing, and up after scrolling down", async () => {
    let shown = 0;
    const handle = {
        url: "https://shop.test/",
        title: "Shop",
        // The viewport moves with each scroll until the end of the page (two screens down).
        snapshot: async () => ({
            text: "A long page",
            controls: [0, 1, 2].map((screen) =>
                control({
                    ref: `e${screen + 1}`,
                    role: "link",
                    name: `Link ${screen}`,
                    kind: "a",
                    inView: shown === screen,
                }),
            ),
            truncated: false,
        }),
        scroll: async (_target: unknown, dy?: number) => {
            shown = Math.max(0, Math.min(2, shown + Math.sign(dy ?? 0)));

            return "";
        },
    } as unknown as BrowserPageHandle;
    const page = runPage(handle);
    let seen = await page.observe();

    assert.deepEqual([seen.below, seen.above], [true, false]);
    await page.scroll("down");
    seen = await page.observe();
    assert.deepEqual([seen.below, seen.above], [true, true]);
    await page.scroll("down");
    await page.observe();
    // The third scroll down changes nothing: that is the end of the page.
    await page.scroll("down");
    seen = await page.observe();
    assert.deepEqual([seen.below, seen.above], [false, true]);
    await page.scroll("up");
    seen = await page.observe();
    assert.equal(seen.below, true);
});

test("Jev gets every criterion as a string, and its cost is read from its usage", async () => {
    const bodies: { url: string; body: Record<string, unknown>; key: string }[] = [];
    const answer = (status: number, body: unknown) =>
        (async (url: string | URL | Request, init?: RequestInit) => {
            bodies.push({
                url: String(url),
                body: JSON.parse(String(init?.body)) as Record<string, unknown>,
                key: String((init?.headers as Record<string, string>).authorization),
            });

            return new Response(JSON.stringify(body), { status });
        }) as typeof fetch;
    const questions: Record<string, Question> = {
        operation: {
            type: "choice",
            criteria: { CLICK: "Click", DONE: "Done" },
            instructions: "Pick",
        },
        goal_achieved: {
            type: "noul",
            criteria: { true: "yes", false: "no" },
            instructions: "Done?",
        },
    };
    const state: DecisionState = {
        page: { url: "https://x.test/", title: "X", text: "" },
        elements: [],
        recent_actions: [],
    };
    const jev = new JevDecider(
        "sk-or-test",
        "typesafe/jev-1.13",
        answer(200, {
            answers: { operation: { choice: "CLICK" }, goal_achieved: { noul: 0.1 } },
            usage: { cost: 0.00003, input_tokens: 729, output_tokens: 104 },
        }),
    );
    const decided = await jev.decide(state, questions);

    assert.equal(bodies[0]!.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(bodies[0]!.key, "Bearer sk-or-test");
    assert.equal(bodies[0]!.body.model, "typesafe/jev-1.13");
    assert.deepEqual(decided.spent, { cost: 0.00003, input: 729, output: 104 });
    assert.equal(decided.answers.operation!.choice, "CLICK");

    const refused = new JevDecider(
        "k",
        "typesafe/jev-1.13",
        answer(404, {
            error: { message: "No allowed providers are available for the selected model" },
        }),
    );

    await assert.rejects(refused.decide(state, questions), /HTTP 404\): No allowed providers/);
});

test("the session's model may leave out answers the step does not need, and a refused answer still counts", async () => {
    const replies = [
        '{"operation": {"choice": "TYPE_TEXT"}, "type_text_target": {"choice": "1"}, "value_for_field": {"choice": "query"}}',
        '{"operation": {"choice": "CLICK"}}',
    ];
    const decider = new SessionDecider("the session's model", async () => ({
        text: replies.shift() ?? "no JSON here",
        spent: { cost: 0.01, input: 50, output: 5 },
    }));
    const { page, done } = fakePage(SHOP_CONTROLS, (what, page) => {
        page.controls[0]!.value = what.slice("type e1 ".length);
    });
    const result = await runGoal(page, decider, options({ query: "lamp" }));

    assert.deepEqual(done, ["type e1 lamp"]);
    assert.equal(result.reason, "decision_error");
    assert.match(result.detail ?? "", /chose CLICK without a target/);
    assert.equal(result.decisions, 2);
    assert.ok(Math.abs(result.spent.cost - 0.02) < 1e-9, "both replies cost");

    const unreadable = await runGoal(
        fakePage(SHOP_CONTROLS, () => {}).page,
        new SessionDecider("x", async () => ({
            text: "sorry",
            spent: { cost: 0.5, input: 1, output: 1 },
        })),
        options(),
    );

    assert.equal(unreadable.reason, "decision_error");
    assert.equal(unreadable.spent.cost, 0.5);
});

test("the run model is the owner's choice, kept in the data folder: the session's, or a TypeSafe model", () => {
    const setting = new RunModelSetting(mkdtempSync(join(root, "setting-")));

    assert.equal(setting.get(), "session");
    setting.set("typesafe/jev-1.13");
    assert.equal(setting.get(), "typesafe/jev-1.13");
    assert.equal(validRunModel("openai/gpt-5"), false, "only the decisions route's models");
    assert.equal(validRunModel("session"), true);
    assert.equal(addressOf("localhost:5173"), "http://localhost:5173/");
    assert.equal(addressOf("shop.test/lamps"), "https://shop.test/lamps");
    assert.equal(addressOf("file:///etc/hosts"), undefined);
});

test(
    "browser_run runs on the real page with the session's model, and its cost goes to the session",
    real,
    async () => {
        // The session's model: asked a step's questions, it answers from the page it is shown.
        const route = (request: { messages: unknown[] }) => {
            const { role, text } = lastText(request as never);

            if (text.startsWith("You decide one step of a browser task")) {
                const state = JSON.parse(
                    /Page state[^\n]*\n(.*)\n/.exec(text)![1]!,
                ) as DecisionState;
                const search = state.elements.find((each) => each.label === "Search")!;
                const sort = state.elements.find((each) => each.label === "Sort")!;
                const go = state.elements.find((each) => each.label === "Go")!;
                const operation = state.page.text.includes("Results for lamp sorted by new")
                    ? "DONE"
                    : search.value !== "lamp"
                      ? "TYPE_TEXT"
                      : sort.value !== "Newest"
                        ? "SELECT"
                        : "CLICK";

                return fauxAssistantMessage([
                    fauxText(
                        JSON.stringify({
                            operation: { choice: operation },
                            type_text_target: { choice: search.index },
                            value_for_field: { choice: "query" },
                            click_target: { choice: go.index },
                            select_target: { choice: `${sort.index}:2` },
                            prev_ok: { noul: 1 },
                            goal_achieved: { noul: operation === "DONE" ? 1 : 0 },
                        }),
                    ),
                ]);
            }

            if (role === "user" && text.includes("find lamps")) {
                return fauxAssistantMessage(
                    [
                        fauxToolCall("browser_run", {
                            goal: "Search for lamps, sorted by newest",
                            values: { query: "lamp" },
                            url: base,
                        }),
                    ],
                    { stopReason: "toolUse" },
                );
            }

            return fauxAssistantMessage([
                fauxText(role === "toolResult" ? `run said: ${text}` : "ok"),
            ]);
        };
        const dataDir = join(root, "app");
        const dropIns = join(dataDir, "extensions");

        mkdirSync(dropIns, { recursive: true });
        cpSync(join(import.meta.dirname, "browser-runs.ts"), join(dropIns, "browser-runs.ts"));
        cpSync(join(import.meta.dirname, "browser-runs.js"), join(dropIns, "browser-runs.js"));
        const app = await openApp(scriptedModel(route), dataDir);

        try {
            await app.setExtensionEnabled(owner(app), "browser-runs.ts", true);
            const id = await newSession(app);

            await say(app, id, "find lamps");

            const texts = (await modelTexts(app, id)).join("\n");

            assert.match(texts, /Done in 3 steps\./);
            assert.match(texts, /typed query into \[e\d+\] Search/);
            assert.match(texts, /Results for lamp sorted by new/);
            assert.doesNotMatch(texts, /hunter22/, "never a password's value");

            const usage = await app.harness.snapshot(UsageDoc, id, context);

            assert.ok(
                (usage?.tools.browser_run?.input ?? 0) > 0,
                "the run's tokens are the session's",
            );
        } finally {
            await app.close();
        }
    },
);
