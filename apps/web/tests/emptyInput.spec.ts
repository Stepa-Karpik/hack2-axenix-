import { test, expect, type APIRequestContext } from "@playwright/test";
import { headers, head } from "./fileFixtures";

// A failed EOF observation must stay visible; a retry could conceal intermittent attachment hangs.
test.describe.configure({ retries: 0 });
const utf8 = "Привет 😀\n";
const files = [
  {
    path: "EmptyBytes.java",
    content: `import java.nio.charset.StandardCharsets;
public class EmptyBytes {
  public static void main(String[] args) throws Exception {
    byte[] bytes = System.in.readAllBytes();
    System.out.println("bytes=" + bytes.length);
    System.out.print(new String(bytes, StandardCharsets.UTF_8));
  }
}\n`,
  },
  {
    path: "EmptyScanner.java",
    content: `import java.nio.charset.StandardCharsets;
import java.util.Scanner;
public class EmptyScanner {
  public static void main(String[] args) {
    Scanner input = new Scanner(System.in, StandardCharsets.UTF_8);
    if (input.hasNextLine()) System.out.println("line=" + input.nextLine());
    else System.out.println("eof");
  }
}\n`,
  },
];

async function fixture(request: APIRequestContext, entryPoint: string) {
  const created = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Empty stdin EOF " + entryPoint + " " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).data.id as string;
  const base = "/api/v1/projects/" + id;
  const save = async (previous: string, candidate: boolean) => {
    const response = await request.post(base + "/revisions", {
      headers: await headers(request, previous),
      data: {
        files: files.map((file) => ({
          ...file,
          content:
            file.content +
            (candidate ? "// behavior-preserving candidate\n" : ""),
        })),
        intent: "semantic_edit",
      },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).data;
  };
  const original = await save("empty", false);
  const candidate = await save(original.id, true);
  return { base, original, candidate };
}

for (const entryPoint of ["EmptyBytes", "EmptyScanner"]) {
  test(`${entryPoint} receives immediate EOF for fixed empty stdin, with UTF-8 control and exact 3+3 observations`, async ({
    page,
  }, info) => {
    test.setTimeout(240000);
    const request = page.request;
    const capabilities = (
      await (await request.get("/api/v1/capabilities")).json()
    ).data;
    expect(
      capabilities.runner.available,
      "Real isolated Docker runner is required",
    ).toBe(true);
    const f = await fixture(request, entryPoint);
    const emptyOutput = entryPoint === "EmptyBytes" ? "bytes=0\n" : "eof\n";
    // 12 Cyrillic bytes + space + four-byte emoji + newline = 18, independently specified.
    const utf8Output =
      entryPoint === "EmptyBytes" ? "bytes=18\n" + utf8 : "line=" + utf8;
    const cases = [
      {
        id: "empty-before",
        name: "EOF before nonempty control",
        stdinUtf8: "",
        expectedStdout: emptyOutput,
      },
      {
        id: "utf8",
        name: "Nonempty UTF-8 control",
        stdinUtf8: utf8,
        expectedStdout: utf8Output,
      },
      {
        id: "empty-after",
        name: "EOF after nonempty control",
        stdinUtf8: "",
        expectedStdout: emptyOutput,
      },
    ].map((row) => ({
      ...row,
      argv: [],
      expectedExitCode: 0,
      expectedStderr: "",
    }));
    const suiteResponse = await request.post(f.base + "/test-suites", {
      headers: await headers(request),
      data: {
        mode: "console",
        entryPoint,
        comparisonPolicyId: "exact-v1",
        cases,
      },
    });
    expect(suiteResponse.status()).toBe(201);
    const suite = (await suiteResponse.json()).data;
    const started = await request.post(f.base + "/comparisons", {
      headers: await headers(request),
      data: {
        baseRevisionId: f.original.id,
        candidateRevisionId: f.candidate.id,
        suiteVersionId: suite.id,
        profileId: "java21-v1",
      },
    });
    expect(started.status()).toBe(202);
    const jobId = (await started.json()).data.id;
    let terminal: any;
    await expect
      .poll(
        async () => {
          const response = await request.get(f.base + "/jobs/" + jobId);
          expect(response.status()).toBe(200);
          terminal = (await response.json()).data;
          return terminal.status;
        },
        { timeout: 210000 },
      )
      .toMatch(/^(succeeded|failed|cancelled)$/);
    expect(terminal.status, JSON.stringify(terminal)).toBe("succeeded");
    const report = terminal.result.report;
    expect(report).toMatchObject({
      outcome: "matched_on_tests",
      coverageComplete: true,
      matched: 3,
      total: 3,
      plannedRepeatCount: 3,
      observedRepeatCounts: {
        base: 3 * cases.length,
        candidate: 3 * cases.length,
      },
      baseRevisionId: f.original.id,
      candidateRevisionId: f.candidate.id,
      suiteVersionId: suite.id,
    });
    expect(report.testResults).toHaveLength(3);
    let observations = 0;
    for (const expected of cases) {
      const row = report.testResults.find(
        (result: any) => result.caseId === expected.id,
      );
      expect(row, expected.id).toBeTruthy();
      expect(row.verdict).toBe("matched");
      expect(row.baseExecutions).toHaveLength(3);
      expect(row.candidateExecutions).toHaveLength(3);
      for (const execution of [
        ...row.baseExecutions,
        ...row.candidateExecutions,
      ]) {
        expect(
          execution,
          `${entryPoint}/${expected.id} observation ${observations}`,
        ).toMatchObject({
          outcome: "exited",
          exitCode: 0,
          stdoutUtf8: expected.expectedStdout,
          stderrUtf8: "",
          truncated: false,
        });
        observations++;
      }
    }
    expect(observations).toBe(18);
    expect((await head(request, f.base)).id).toBe(f.candidate.id);
    await info.attach("empty-stdin-" + entryPoint + "-exact-report", {
      body: JSON.stringify(report),
      contentType: "application/json",
    });
  });
}
