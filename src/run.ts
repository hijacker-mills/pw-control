import type { Command, GlobalOptions } from "./cli_args.js";
import { connectOrLaunchChrome, ensureContext, ensurePage, listPages } from "./session.js";
import { writeFile } from "node:fs/promises";
import { ensurePwProfileDir, listPwProfiles, resolvePwProfileDir } from "./profiles.js";
import { resolveSmartSelector, formatSelectorResult, isLikelyCssSelector, isLikelyPlainText } from "./util_selectors.js";

type OutputEnvelope = {
  ok: boolean;
  action: string;
  tab?: number;
  url?: string;
  data?: unknown;
  warnings?: string[];
};

type Attempt = {
  name: string;
  run: () => Promise<void>;
};

class SkipAttemptError extends Error {}

export async function run(command: Exclude<Command, { kind: "help" }>): Promise<number> {
  if (command.kind === "profiles-list") {
    const data = listPwProfiles();
    emit(command.options, { ok: true, action: "profiles-list", data }, JSON.stringify(data, null, 2));
    return 0;
  }

  if (command.kind === "profiles-path") {
    const path = resolvePwProfileDir(command.name);
    emit(command.options, { ok: true, action: "profiles-path", data: { path } }, path);
    return 0;
  }

  if (command.kind === "profiles-init") {
    const path = ensurePwProfileDir(command.name);
    emit(command.options, { ok: true, action: "profiles-init", data: { path } }, path);
    return 0;
  }

  const { browser, cleanup } = await connectOrLaunchChrome(command.options);
  try {
    if (command.kind === "tabs-list") {
      const context = await ensureContext(browser);
      const pages = listPages(context);
      const out: Array<{ index: number; url: string; title?: string }> = [];
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        out.push({ index: i, url: page.url(), title: await safeTitle(page) });
      }
      emit(command.options, { ok: true, action: "tabs-list", data: out }, JSON.stringify(out, null, 2));
      return 0;
    }

    if (command.kind === "tabs-open") {
      const context = await ensureContext(browser);
      const page = await context.newPage();
      await page.goto(command.url, { waitUntil: command.options.waitUntil, timeout: command.options.timeoutMs });
      const pages = listPages(context);
      const index = Math.max(0, pages.indexOf(page));
      const data = { index, url: page.url() };
      emit(command.options, { ok: true, action: "tabs-open", tab: index, url: data.url, data }, JSON.stringify(data, null, 2));
      return 0;
    }

    if (command.kind === "tabs-close") {
      const { page, index } = await ensurePage(browser, command.options);
      await page.close();
      const data = { closed: true, index };
      emit(command.options, { ok: true, action: "tabs-close", tab: index, data }, JSON.stringify(data, null, 2));
      return 0;
    }

    if (command.kind === "observe-console") {
      const { page, index } = await ensurePage(browser, command.options);
      const startedAt = Date.now();
      const messages: Array<{ ts: number; level: string; text: string; url?: string }> = [];

      const handler = (msg: any) => {
        const level = msg.type?.() ?? "log";
        if (command.options.level && command.options.level !== level) return;
        messages.push({ ts: Date.now(), level, text: msg.text?.() ?? String(msg), url: msg.location?.()?.url });
      };

      page.on("console", handler);
      await sleep(command.options.timeMs);
      page.off("console", handler);

      const data = { ok: true, tab: index, startedAt, messages };
      emit(command.options, { ok: true, action: "observe-console", tab: index, url: page.url(), data }, JSON.stringify(data, null, 2));
      return 0;
    }

    if (command.kind === "observe-requests") {
      const { page, index } = await ensurePage(browser, command.options);
      const startedAt = Date.now();
      const requests: Array<{ ts: number; method: string; url: string; resourceType?: string }> = [];

      const handler = (req: any) => {
        const url = req.url?.() ?? "";
        if (command.options.filter && !url.includes(command.options.filter)) return;
        requests.push({ ts: Date.now(), method: req.method?.() ?? "GET", url, resourceType: req.resourceType?.() });
      };

      page.on("request", handler);
      await sleep(command.options.timeMs);
      page.off("request", handler);

      const data = { ok: true, tab: index, startedAt, requests };
      emit(command.options, { ok: true, action: "observe-requests", tab: index, url: page.url(), data }, JSON.stringify(data, null, 2));
      return 0;
    }

    if (command.kind === "state") {
      const { context, page, index } = await ensurePage(browser, command.options);
      const pages = listPages(context);
      const tabs: Array<{ index: number; url: string; title?: string }> = [];
      for (let i = 0; i < pages.length; i++) {
        tabs.push({ index: i, url: pages[i].url(), title: await safeTitle(pages[i]) });
      }
      const data = {
        tab: index,
        url: page.url(),
        title: await safeTitle(page),
        viewport: page.viewportSize() ?? undefined,
        userAgent: await safeUserAgent(page),
        tabs
      };
      emit(command.options, { ok: true, action: "state", tab: index, url: data.url, data }, JSON.stringify(data, null, 2));
      return 0;
    }

    const { context, page, index: tabIndex } = await ensurePage(browser, command.options);

    if (command.kind === "navigate") {
      await page.goto(command.url, { waitUntil: command.options.waitUntil, timeout: command.options.timeoutMs });
      const url = page.url();
      emit(command.options, { ok: true, action: "navigate", tab: tabIndex, url, data: { requestedUrl: command.url } }, url);
      return 0;
    }

    if (command.kind === "eval-js") {
      const result = await page.evaluate((code) => (0, eval)(code), command.code);
      emit(command.options, { ok: true, action: "eval-js", tab: tabIndex, url: page.url(), data: { result } }, safeStringify(result));
      return 0;
    }

    if (command.kind === "save-cookies") {
      const cookies = await context.cookies();
      await writeFile(command.outFile, JSON.stringify(cookies, null, 2), "utf8");
      emit(command.options, { ok: true, action: "save-cookies", tab: tabIndex, url: page.url(), data: { outFile: command.outFile } }, command.outFile);
      return 0;
    }

    if (command.kind === "screenshot") {
      await page.screenshot({ path: command.outFile, fullPage: command.fullPage });
      emit(command.options, { ok: true, action: "screenshot", tab: tabIndex, url: page.url(), data: { outFile: command.outFile, fullPage: command.fullPage } }, command.outFile);
      return 0;
    }

    if (command.kind === "snapshot") {
      const snapshot: {
        title: string;
        url: string;
        timestamp: string;
        text: string;
        headings: string[];
        links: Array<{ text: string; href: string }>;
        buttons: string[];
        inputs: Array<{ name: string; type: string; placeholder: string; label: string }>;
        images: Array<{ alt: string; src: string }>;
        html?: string;
        screenshot?: string;
        a11y?: unknown;
      } = await page.evaluate(
        ({ maxText, maxItems, includeHtml }) => {
          const trim = (value: string, limit: number) => {
            if (!value) return "";
            return value.length > limit ? value.slice(0, limit) : value;
          };
          const clean = (value: string) => (value || "").replace(/\s+/g, " ").trim();

          const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
            .map((el) => clean(el.textContent))
            .filter(Boolean)
            .slice(0, maxItems);

          const links = Array.from(document.querySelectorAll("a"))
            .map((el) => {
              const anchor = el as HTMLAnchorElement;
              return {
                text: clean(anchor.textContent),
                href: anchor.href
              };
            })
            .filter((item) => item.href)
            .slice(0, maxItems);

          const buttons = Array.from(document.querySelectorAll("button, [role=button]"))
            .map((el) => clean(el.textContent || el.getAttribute("aria-label") || ""))
            .filter(Boolean)
            .slice(0, maxItems);

          const inputs = Array.from(document.querySelectorAll("input, textarea, select"))
            .map((el) => {
              const anyEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
              const name = anyEl.getAttribute("name") || "";
              const type = anyEl.getAttribute("type") || anyEl.tagName.toLowerCase();
              const placeholder = anyEl.getAttribute("placeholder") || "";
              const label = anyEl.getAttribute("aria-label") || "";
              return { name, type, placeholder, label };
            })
            .filter((item) => item.name || item.placeholder || item.label)
            .slice(0, maxItems);

          const images = Array.from(document.querySelectorAll("img"))
            .map((el) => {
              const img = el as HTMLImageElement;
              return { alt: clean(img.alt || ""), src: img.currentSrc || img.src || "" };
            })
            .filter((item) => item.src)
            .slice(0, maxItems);

          const text = trim(document.body?.innerText || "", maxText);
          const html = includeHtml ? trim(document.documentElement?.outerHTML || "", maxText) : undefined;

          return {
            title: document.title,
            url: location.href,
            timestamp: new Date().toISOString(),
            text,
            headings,
            links,
            buttons,
            inputs,
            images,
            html
          };
        },
        { maxText: command.maxText, maxItems: command.maxItems, includeHtml: command.includeHtml }
      );

      if (command.includeA11y) {
        snapshot.a11y = await (page as any).accessibility.snapshot();
      }

      if (command.screenshotFile) {
        await page.screenshot({ path: command.screenshotFile, fullPage: command.fullPage });
        snapshot.screenshot = command.screenshotFile;
      }

      const payload = JSON.stringify(snapshot, null, 2);
      if (command.outFile) {
        await writeFile(command.outFile, payload, "utf8");
        emit(
          command.options,
          {
            ok: true,
            action: "snapshot",
            tab: tabIndex,
            url: page.url(),
            data: { outFile: command.outFile, screenshot: command.screenshotFile }
          },
          command.outFile
        );
        return 0;
      }

      emit(command.options, { ok: true, action: "snapshot", tab: tabIndex, url: page.url(), data: snapshot }, payload);
      return 0;
    }

    if (command.kind === "click") {
      let emitted = false;
      try {
        const timeout = command.options.timeoutMs;
        const clickOptions = {
          button: command.options.button,
          clickCount: command.options.clickCount,
          timeout,
          force: command.options.force
        } as const;

        const withFrames = async (runner: (frame: any) => Promise<void>) => runInChildFrames(page, runner);

        const clickWithLocator = async (timeoutMs: number) => {
          const locator = page.locator(command.selector);

          if (command.options.nth !== undefined) {
            await locator.nth(command.options.nth).click({ ...clickOptions, timeout: timeoutMs });
            return;
          }

          const count = await locator.count();
          let clicked = false;

          for (let i = 0; i < count; i++) {
            const candidate = locator.nth(i);
            if (await candidate.isVisible().catch(() => false)) {
              await candidate.click({ ...clickOptions, timeout: timeoutMs });
              clicked = true;
              break;
            }
          }

          if (!clicked) {
            if (count === 0) {
              throw new Error(`No elements match selector: ${command.selector}`);
            }
            if (command.options.fallbackFirst) {
              await locator.first().click({ ...clickOptions, timeout: timeoutMs });
              return;
            }
            throw new Error(`No visible elements match selector: ${command.selector}. Use --fallback-first to click the first match.`);
          }
        };

        const attempts: Attempt[] = [];
        const plainText = isLikelyPlainText(command.selector);
        const canUseSmart = command.options.smartSelector && isLikelyCssSelector(command.selector) && !plainText;

        if (canUseSmart) {
          attempts.push({
            name: "smart-css",
            run: async () => {
              const result = await resolveSmartSelector(page, command.selector, {
                timeout,
                maxTraversals: command.options.maxTraversals || 3,
                tryCss: true,
                tryText: true,
                debug: command.options.debugSelector || false
              });

              if (!result.success || !result.selector) {
                throw new Error(`Smart selector failed: No clickable element found for "${command.selector}" or its parents`);
              }

              await page.click(result.selector, clickOptions);

              const selectorInfo = formatSelectorResult(result);
              const payload = JSON.stringify(
                {
                  ok: true,
                  originalSelector: command.selector,
                  resolvedSelector: result.selector,
                  selectorType: result.selectorType,
                  selectorInfo
                },
                null,
                2
              );

              emit(
                command.options,
                {
                  ok: true,
                  action: "click",
                  tab: tabIndex,
                  url: page.url(),
                  data: {
                    originalSelector: command.selector,
                    resolvedSelector: result.selector,
                    selectorType: result.selectorType,
                    selectorInfo
                  }
                },
                payload
              );
              emitted = true;
            }
          });
        }

        if (!plainText) {
          attempts.push({
            name: "locator",
            run: () => clickWithLocator(timeout)
          });
        }
        if (plainText) {
          attempts.push({
            name: "by-text",
            run: async () => {
              await page.getByText(command.selector, { exact: true }).first().click(clickOptions);
            }
          });
          attempts.push({
            name: "by-text-fuzzy",
            run: async () => {
              await page.getByText(command.selector).first().click(clickOptions);
            }
          });
          attempts.push({
            name: "by-role-button",
            run: async () => {
              await page.getByRole("button", { name: command.selector }).first().click(clickOptions);
            }
          });
          attempts.push({
            name: "by-role-link",
            run: async () => {
              await page.getByRole("link", { name: command.selector }).first().click(clickOptions);
            }
          });
          attempts.push({
            name: "by-label",
            run: async () => {
              await page.getByLabel(command.selector).first().click(clickOptions);
            }
          });
          attempts.push({
            name: "consent-retry",
            run: async () => {
              const consentPattern = /^(i agree|accept all|accept|agree|reject all|reject|got it)$/i;
              const tryInFrame = async (frame: any) => {
                try {
                  await frame.getByRole("button", { name: consentPattern }).first().click({ timeout: 2000 });
                  return;
                } catch {
                  // Ignore and fall back to text matching
                }
                const texts = ["I agree", "Accept all", "Accept", "Agree", "Reject all", "Reject", "Got it"];
                for (const text of texts) {
                  try {
                    await frame.getByText(text, { exact: true }).first().click({ timeout: 2000 });
                    return;
                  } catch {
                    // Ignore and try next text
                  }
                }
              };
              await tryInFrame(page);
              const frames = page.frames().filter((f) => f !== page.mainFrame());
              for (const frame of frames) {
                await tryInFrame(frame);
              }
              await page.getByRole("link", { name: command.selector }).first().click(clickOptions);
            }
          });
        }

        attempts.push({
          name: "frames-selector",
          run: async () => {
            await withFrames(async (frame) => {
              await frame.locator(command.selector).first().click(clickOptions);
            });
          }
        });

        if (plainText) {
          attempts.push({
            name: "frames-by-text",
            run: async () => {
              await withFrames(async (frame) => {
                await frame.getByText(command.selector).first().click(clickOptions);
              });
            }
          });
          attempts.push({
            name: "frames-by-role-button",
            run: async () => {
              await withFrames(async (frame) => {
                await frame.getByRole("button", { name: command.selector }).first().click(clickOptions);
              });
            }
          });
          attempts.push({
            name: "frames-by-role-link",
            run: async () => {
              await withFrames(async (frame) => {
                await frame.getByRole("link", { name: command.selector }).first().click(clickOptions);
              });
            }
          });
        }

        let lastError: unknown;
        let clicked = false;
        const perAttemptTimeout = Math.min(4000, Math.max(1500, Math.floor(timeout / Math.max(1, attempts.length))));
        const clickOptionsFast = { ...clickOptions, timeout: perAttemptTimeout };

        for (const attempt of attempts) {
          try {
            if (attempt.name === "by-text") {
              await page.getByText(command.selector, { exact: true }).first().click(clickOptionsFast);
            } else if (attempt.name === "by-text-fuzzy") {
              await page.getByText(command.selector).first().click(clickOptionsFast);
            } else if (attempt.name === "by-role-button") {
              await page.getByRole("button", { name: command.selector }).first().click(clickOptionsFast);
            } else if (attempt.name === "by-role-link") {
              await page.getByRole("link", { name: command.selector }).first().click(clickOptionsFast);
            } else if (attempt.name === "by-label") {
              await page.getByLabel(command.selector).first().click(clickOptionsFast);
            } else if (attempt.name === "frames-by-text") {
              await withFrames(async (frame) => {
                await frame.getByText(command.selector).first().click(clickOptionsFast);
              });
            } else if (attempt.name === "frames-by-role-button") {
              await withFrames(async (frame) => {
                await frame.getByRole("button", { name: command.selector }).first().click(clickOptionsFast);
              });
            } else if (attempt.name === "frames-by-role-link") {
              await withFrames(async (frame) => {
                await frame.getByRole("link", { name: command.selector }).first().click(clickOptionsFast);
              });
            } else if (attempt.name === "locator") {
              await clickWithLocator(perAttemptTimeout);
            } else {
              await attempt.run();
            }
            clicked = true;
            break;
          } catch (err) {
            lastError = err;
          }
        }

        if (!clicked && lastError) {
          throw lastError;
        }
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "click",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      if (!emitted) {
        const payload = JSON.stringify({ ok: true }, null, 2);
        emit(command.options, { ok: true, action: "click", tab: tabIndex, url: page.url() }, payload);
      }
      return 0;
    }

    if (command.kind === "click-text") {
      try {
        const timeout = command.options.timeoutMs;
        const attempts: Attempt[] = [
          {
            name: "page-by-text-exact",
            run: async () => {
              await page.getByText(command.text, { exact: true }).first().click({ timeout });
            }
          },
          {
            name: "page-by-text-fuzzy",
            run: async () => {
              await page.getByText(command.text).first().click({ timeout });
            }
          },
          {
            name: "page-by-role-button",
            run: async () => {
              await page.getByRole("button", { name: command.text }).first().click({ timeout });
            }
          },
          {
            name: "page-by-role-link",
            run: async () => {
              await page.getByRole("link", { name: command.text }).first().click({ timeout });
            }
          },
          {
            name: "frames-by-text-exact",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByText(command.text, { exact: true }).first().click({ timeout });
              });
            }
          },
          {
            name: "frames-by-text-fuzzy",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByText(command.text).first().click({ timeout });
              });
            }
          },
          {
            name: "frames-by-role-button",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByRole("button", { name: command.text }).first().click({ timeout });
              });
            }
          },
          {
            name: "frames-by-role-link",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByRole("link", { name: command.text }).first().click({ timeout });
              });
            }
          }
        ];
        await runAttempts(attempts);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "click-text",
          selector: command.text,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "click-text", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "click-role") {
      try {
        const timeout = command.options.timeoutMs;
        const role = command.role as any;
        const options = command.name ? { name: command.name } : undefined;
        await runAttempts([
          {
            name: "page-role",
            run: async () => {
              await page.getByRole(role, options).first().click({ timeout });
            }
          },
          {
            name: "frames-role",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByRole(role, options).first().click({ timeout });
              });
            }
          }
        ]);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "click-role",
          selector: command.name ? `${command.role}:${command.name}` : command.role,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "click-role", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "hover") {
      try {
        const timeout = command.options.timeoutMs;
        const plainText = isLikelyPlainText(command.selector);
        const attempts: Attempt[] = [
          {
            name: "page-selector",
            run: async () => {
              await page.locator(command.selector).first().hover({ timeout });
            }
          },
          {
            name: "frames-selector",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.locator(command.selector).first().hover({ timeout });
              });
            }
          }
        ];

        if (plainText) {
          attempts.push(
            {
              name: "page-by-text-exact",
              run: async () => {
                await page.getByText(command.selector, { exact: true }).first().hover({ timeout });
              }
            },
            {
              name: "page-by-text-fuzzy",
              run: async () => {
                await page.getByText(command.selector).first().hover({ timeout });
              }
            },
            {
              name: "frames-by-text",
              run: async () => {
                await runInChildFrames(page, async (frame) => {
                  await frame.getByText(command.selector).first().hover({ timeout });
                });
              }
            }
          );
        }

        await runAttempts(attempts);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "hover",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "hover", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "type") {
      try {
        const timeout = command.options.timeoutMs;
        const delayMs =
          command.options.delayMs !== undefined ? Math.max(0, command.options.delayMs) : undefined;
        const plainText = isLikelyPlainText(command.selector);

        const typeViaLocator = async (target: any, selector: string) => {
          const locator = target.locator(selector).first();
          await locator.click({ timeout });
          await locator.type(command.text, { timeout, delay: delayMs });
        };

        const fillViaLocator = async (target: any, selector: string) => {
          await target.locator(selector).first().fill(command.text, { timeout });
        };

        const attempts: Attempt[] = [
          {
            name: "page-selector-type",
            run: async () => {
              await typeViaLocator(page, command.selector);
            }
          },
          {
            name: "page-selector-fill",
            run: async () => {
              await fillViaLocator(page, command.selector);
            }
          },
          {
            name: "frames-selector-type",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await typeViaLocator(frame, command.selector);
              });
            }
          },
          {
            name: "frames-selector-fill",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await fillViaLocator(frame, command.selector);
              });
            }
          },
          {
            name: "single-visible-textbox-page",
            run: async () => {
              const locator = page.locator('input:not([type="hidden"]), textarea');
              const count = await locator.count();
              if (count !== 1) throw new Error("No unique visible textbox on page");
              await locator.first().fill(command.text, { timeout });
            }
          },
          {
            name: "single-visible-textbox-frame",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                const locator = frame.locator('input:not([type="hidden"]), textarea');
                const count = await locator.count();
                if (count !== 1) throw new Error("No unique visible textbox in frame");
                await locator.first().fill(command.text, { timeout });
              });
            }
          }
        ];

        if (plainText) {
          attempts.push(
            {
              name: "page-by-label",
              run: async () => {
                await page.getByLabel(command.selector).first().fill(command.text, { timeout });
              }
            },
            {
              name: "page-by-placeholder",
              run: async () => {
                await page.getByPlaceholder(command.selector).first().fill(command.text, { timeout });
              }
            },
            {
              name: "page-by-role-textbox",
              run: async () => {
                await page.getByRole("textbox", { name: command.selector }).first().fill(command.text, { timeout });
              }
            },
            {
              name: "frames-by-label",
              run: async () => {
                await runInChildFrames(page, async (frame) => {
                  await frame.getByLabel(command.selector).first().fill(command.text, { timeout });
                });
              }
            },
            {
              name: "frames-by-placeholder",
              run: async () => {
                await runInChildFrames(page, async (frame) => {
                  await frame.getByPlaceholder(command.selector).first().fill(command.text, { timeout });
                });
              }
            },
            {
              name: "frames-by-role-textbox",
              run: async () => {
                await runInChildFrames(page, async (frame) => {
                  await frame.getByRole("textbox", { name: command.selector }).first().fill(command.text, { timeout });
                });
              }
            }
          );
        }

        await runAttempts(attempts);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "type",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "type", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "press") {
      try {
        await page.keyboard.press(command.key, {
          delay: command.options.delayMs ? Math.max(0, command.options.delayMs) : undefined
        });
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "press",
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "press", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "drag") {
      try {
        const timeout = command.options.timeoutMs;

        const startIsText = isLikelyPlainText(command.startSelector);
        const endIsText = isLikelyPlainText(command.endSelector);
        const getTarget = (scope: any, query: string, isText: boolean) =>
          (isText ? scope.getByText(query) : scope.locator(query)).first();

        const dragInScope = async (scope: any) => {
          const source = getTarget(scope, command.startSelector, startIsText);
          const target = getTarget(scope, command.endSelector, endIsText);
          await source.dragTo(target, { timeout });
        };

        const attempts: Attempt[] = [
          {
            name: "page-drag",
            run: async () => {
              await dragInScope(page);
            }
          },
          {
            name: "frames-drag",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await dragInScope(frame);
              });
            }
          },
          {
            name: "page-mouse-drag",
            run: async () => {
              const source = getTarget(page, command.startSelector, startIsText);
              const target = getTarget(page, command.endSelector, endIsText);
              await mouseDragBetween(page, source, target, timeout);
            }
          }
        ];

        await runAttempts(attempts);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "drag",
          selector: `${command.startSelector} -> ${command.endSelector}`,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "drag", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "scroll-into-view") {
      try {
        const timeout = command.options.timeoutMs;
        const plainText = isLikelyPlainText(command.selector);
        const attempts: Attempt[] = [
          {
            name: "page-selector",
            run: async () => {
              await page.locator(command.selector).first().scrollIntoViewIfNeeded({ timeout });
            }
          },
          {
            name: "frames-selector",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.locator(command.selector).first().scrollIntoViewIfNeeded({ timeout });
              });
            }
          }
        ];

        if (plainText) {
          attempts.push(
            {
              name: "page-by-text",
              run: async () => {
                await page.getByText(command.selector).first().scrollIntoViewIfNeeded({ timeout });
              }
            },
            {
              name: "frames-by-text",
              run: async () => {
                await runInChildFrames(page, async (frame) => {
                  await frame.getByText(command.selector).first().scrollIntoViewIfNeeded({ timeout });
                });
              }
            }
          );
        }

        await runAttempts(attempts);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "scroll-into-view",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "scroll-into-view", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "fill") {
      try {
        const timeout = command.options.timeoutMs;
        const attempts: Attempt[] = [];
        const consentPattern = /^(i agree|accept all|accept|agree|reject all|reject|got it)$/i;

        const tryConsentClicks = async () => {
          const tryInFrame = async (frame: any) => {
            try {
              await frame.getByRole("button", { name: consentPattern }).first().click({ timeout: 2000 });
              return;
            } catch {
              // Ignore and fall back to text matching
            }
            const texts = ["I agree", "Accept all", "Accept", "Agree", "Reject all", "Reject", "Got it"];
            for (const text of texts) {
              try {
                await frame.getByText(text, { exact: true }).first().click({ timeout: 2000 });
                return;
              } catch {
                // Ignore and try next text
              }
            }
          };
          await tryInFrame(page);
          const frames = page.frames().filter((f) => f !== page.mainFrame());
          for (const frame of frames) {
            await tryInFrame(frame);
          }
        };

        const trimmedSelector = command.selector.trim();
        const isInputSelector = trimmedSelector.startsWith("input");
        const hasNameQ = /name\s*=\s*["']?q["']?/i.test(trimmedSelector);

        attempts.push({
          name: "selector",
          run: async () => {
            await page.fill(command.selector, command.value, { timeout });
          }
        });

        if (isInputSelector) {
          const altSelector = trimmedSelector.replace(/^input\b/, "textarea");
          attempts.push({
            name: "selector-alt-textarea",
            run: async () => {
              await page.fill(altSelector, command.value, { timeout });
            }
          });
        }

        if (hasNameQ) {
          attempts.push({
            name: "selector-q-both",
            run: async () => {
              await page.locator('input[name="q"], textarea[name="q"]').first().fill(command.value, { timeout });
            }
          });
        }

        const plainText = isLikelyPlainText(command.selector);
        if (plainText) {
          attempts.push({
            name: "by-label",
            run: async () => {
              await page.getByLabel(command.selector).first().fill(command.value, { timeout });
            }
          });
          attempts.push({
            name: "by-placeholder",
            run: async () => {
              await page.getByPlaceholder(command.selector).first().fill(command.value, { timeout });
            }
          });
          attempts.push({
            name: "by-role-textbox",
            run: async () => {
              await page.getByRole("textbox", { name: command.selector }).first().fill(command.value, { timeout });
            }
          });
        }

        attempts.push({
          name: "frames-selector",
          run: async () => {
            await runInChildFrames(page, async (frame) => {
              await frame.locator(command.selector).first().fill(command.value, { timeout });
            });
          }
        });

        if (isInputSelector) {
          const altSelector = trimmedSelector.replace(/^input\b/, "textarea");
          attempts.push({
            name: "frames-selector-alt-textarea",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.locator(altSelector).first().fill(command.value, { timeout });
              });
            }
          });
        }

        if (hasNameQ) {
          attempts.push({
            name: "frames-selector-q-both",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.locator('input[name="q"], textarea[name="q"]').first().fill(command.value, { timeout });
              });
            }
          });
        }

        attempts.push({
          name: "consent-retry",
          run: async () => {
            await tryConsentClicks();
            await page.fill(command.selector, command.value, { timeout });
          }
        });

        attempts.push({
          name: "first-visible-textbox",
          run: async () => {
            const locator = page.locator('input:not([type="hidden"]), textarea');
            const count = await locator.count();
            if (count === 1) {
              await locator.first().fill(command.value, { timeout });
              return;
            }
            throw new Error("Multiple visible inputs; no safe fallback");
          }
        });

        attempts.push({
          name: "frames-first-visible-textbox",
          run: async () => {
            await runInChildFrames(page, async (frame) => {
              const locator = frame.locator('input:not([type="hidden"]), textarea');
              const count = await locator.count();
              if (count !== 1) throw new Error("No unique visible textbox in frame");
              await locator.first().fill(command.value, { timeout });
            });
          }
        });

        attempts.push({
          name: "search-heuristic",
          run: async () => {
            await page.getByRole("textbox", { name: /search/i }).first().fill(command.value, { timeout });
          }
        });

        if (plainText) {
          attempts.push({
            name: "frames-by-label",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByLabel(command.selector).first().fill(command.value, { timeout });
              });
            }
          });
          attempts.push({
            name: "frames-by-placeholder",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByPlaceholder(command.selector).first().fill(command.value, { timeout });
              });
            }
          });
          attempts.push({
            name: "frames-by-role-textbox",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByRole("textbox", { name: command.selector }).first().fill(command.value, { timeout });
              });
            }
          });
        }

        let lastError: unknown;
        let filled = false;
        for (const attempt of attempts) {
          try {
            await attempt.run();
            filled = true;
            break;
          } catch (err) {
            lastError = err;
          }
        }

        if (!filled && lastError) {
          throw lastError;
        }
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "fill",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "fill", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "fill-label") {
      try {
        const timeout = command.options.timeoutMs;
        await runAttempts([
          {
            name: "page-label",
            run: async () => {
              await page.getByLabel(command.label).first().fill(command.value, { timeout });
            }
          },
          {
            name: "frames-label",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByLabel(command.label).first().fill(command.value, { timeout });
              });
            }
          }
        ]);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "fill-label",
          selector: command.label,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "fill-label", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "fill-role") {
      try {
        const timeout = command.options.timeoutMs;
        const role = command.role as any;
        await runAttempts([
          {
            name: "page-role",
            run: async () => {
              await page.getByRole(role, { name: command.name }).first().fill(command.value, { timeout });
            }
          },
          {
            name: "frames-role",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByRole(role, { name: command.name }).first().fill(command.value, { timeout });
              });
            }
          }
        ]);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "fill-role",
          selector: `${command.role}:${command.name}`,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "fill-role", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "select") {
      try {
        const timeout = command.options.timeoutMs;
        const valueText = command.values[0];
        const normalizedSelector = command.selector.replace(/[\r\n]+/g, "").trim();
        const plainText = isLikelyPlainText(normalizedSelector);
        const attempts: Attempt[] = [];

        const clickAndChoose = async (clickTarget: () => Promise<void>, scope: any) => {
          await clickTarget();
          const optionByRole = scope.getByRole?.("option", { name: valueText });
          if (optionByRole) {
            await optionByRole.first().click({ timeout });
            return;
          }
          await scope.getByText(valueText, { exact: true }).first().click({ timeout });
        };

        attempts.push({
          name: "selector-native",
          run: async () => {
            await page.selectOption(normalizedSelector, command.values, { timeout });
          }
        });

        attempts.push({
          name: "selector-native-eval",
          run: async () => {
            await page.evaluate(
              ({ selector, value }) => {
                const el = document.querySelector(selector);
                if (!el) throw new Error("No select for selector");
                if (!(el instanceof HTMLSelectElement)) throw new Error("Selector is not a <select>");
                const option = Array.from(el.options).find(
                  (o) => o.value === value || o.label === value || o.text === value
                );
                if (!option) throw new Error("Option not found in select");
                el.value = option.value;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              },
              { selector: normalizedSelector, value: valueText }
            );
          }
        });

        if (plainText) {
          attempts.push({
            name: "label-native",
            run: async () => {
              await page.getByLabel(normalizedSelector).selectOption(command.values, { timeout });
            }
          });
          attempts.push({
            name: "combobox-native",
            run: async () => {
              await page.getByRole("combobox", { name: normalizedSelector }).selectOption(command.values, { timeout });
            }
          });
          attempts.push({
            name: "combobox-custom",
            run: async () => {
              const combo = page.getByRole("combobox", { name: normalizedSelector }).first();
              await clickAndChoose(() => combo.click({ timeout }), page);
            }
          });
          attempts.push({
            name: "label-text-custom",
            run: async () => {
              const label = page.getByText(normalizedSelector, { exact: true }).first();
              await clickAndChoose(() => label.click({ timeout }), page);
            }
          });
        }

        attempts.push({
          name: "frames-selector-native",
          run: async () => {
            await runInChildFrames(page, async (frame) => {
              await frame.selectOption(normalizedSelector, command.values, { timeout });
            });
          }
        });

        attempts.push({
          name: "frames-selector-native-eval",
          run: async () => {
            await runInChildFrames(page, async (frame) => {
              await frame.evaluate(
                ({ selector, value }: { selector: string; value: string }) => {
                  const el = document.querySelector(selector);
                  if (!el) throw new Error("No select for selector");
                  if (!(el instanceof HTMLSelectElement)) throw new Error("Selector is not a <select>");
                  const option = Array.from(el.options).find(
                    (o) => o.value === value || o.label === value || o.text === value
                  );
                  if (!option) throw new Error("Option not found in select");
                  el.value = option.value;
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                },
                { selector: normalizedSelector, value: valueText }
              );
            });
          }
        });

        if (plainText) {
          attempts.push({
            name: "frames-label-native",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.getByLabel(normalizedSelector).selectOption(command.values, { timeout });
              });
            }
          });
          attempts.push({
            name: "frames-combobox-custom",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                const combo = frame.getByRole("combobox", { name: normalizedSelector }).first();
                await clickAndChoose(() => combo.click({ timeout }), frame);
              });
            }
          });
        }

        let lastError: unknown;
        for (const attempt of attempts) {
          try {
            await attempt.run();
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
          }
        }

        if (lastError) {
          throw lastError;
        }
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "select",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "select", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "check") {
      try {
        const timeout = command.options.timeoutMs;
        const plainText = isLikelyPlainText(command.selector);
        const attempts: Attempt[] = [
          {
            name: "page-selector-check",
            run: async () => {
              await page.check(command.selector, { timeout });
            }
          },
          {
            name: "frames-selector-check",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.check(command.selector, { timeout });
              });
            }
          }
        ];

        if (plainText) {
          attempts.push(
            {
              name: "page-by-label",
              run: async () => {
                await page.getByLabel(command.selector).first().check({ timeout });
              }
            },
            {
              name: "frames-by-label",
              run: async () => {
                await runInChildFrames(page, async (frame) => {
                  await frame.getByLabel(command.selector).first().check({ timeout });
                });
              }
            }
          );
        }

        await runAttempts(attempts);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "check",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "check", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "uncheck") {
      try {
        const timeout = command.options.timeoutMs;
        const plainText = isLikelyPlainText(command.selector);
        const attempts: Attempt[] = [
          {
            name: "page-selector-uncheck",
            run: async () => {
              await page.uncheck(command.selector, { timeout });
            }
          },
          {
            name: "frames-selector-uncheck",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.uncheck(command.selector, { timeout });
              });
            }
          }
        ];

        if (plainText) {
          attempts.push(
            {
              name: "page-by-label",
              run: async () => {
                await page.getByLabel(command.selector).first().uncheck({ timeout });
              }
            },
            {
              name: "frames-by-label",
              run: async () => {
                await runInChildFrames(page, async (frame) => {
                  await frame.getByLabel(command.selector).first().uncheck({ timeout });
                });
              }
            }
          );
        }

        await runAttempts(attempts);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "uncheck",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "uncheck", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "upload") {
      try {
        const timeout = command.options.timeoutMs;
        const plainText = isLikelyPlainText(command.selector);
        const attempts: Attempt[] = [
          {
            name: "page-selector-upload",
            run: async () => {
              await page.setInputFiles(command.selector, command.files, { timeout });
            }
          },
          {
            name: "frames-selector-upload",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                await frame.setInputFiles(command.selector, command.files, { timeout });
              });
            }
          },
          {
            name: "page-single-file-input",
            run: async () => {
              const locator = page.locator('input[type="file"]');
              const count = await locator.count();
              if (count !== 1) throw new Error("No unique file input on page");
              await locator.first().setInputFiles(command.files, { timeout });
            }
          },
          {
            name: "frame-single-file-input",
            run: async () => {
              await runInChildFrames(page, async (frame) => {
                const locator = frame.locator('input[type="file"]');
                const count = await locator.count();
                if (count !== 1) throw new Error("No unique file input in frame");
                await locator.first().setInputFiles(command.files, { timeout });
              });
            }
          }
        ];

        if (plainText) {
          attempts.push(
            {
              name: "page-by-label",
              run: async () => {
                await page.getByLabel(command.selector).first().setInputFiles(command.files, { timeout });
              }
            },
            {
              name: "frames-by-label",
              run: async () => {
                await runInChildFrames(page, async (frame) => {
                  await frame.getByLabel(command.selector).first().setInputFiles(command.files, { timeout });
                });
              }
            }
          );
        }

        await runAttempts(attempts);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "upload",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "upload", tab: tabIndex, url: page.url(), data: { files: command.files } }, payload);
      return 0;
    }

    if (command.kind === "wait") {
      const timeout =
        command.options.waitTimeoutMs !== undefined ? command.options.waitTimeoutMs : command.options.timeoutMs;

      try {
        if (command.options.timeMs !== undefined) {
          await sleep(command.options.timeMs);
        }

        if (command.options.selector) {
          await page.waitForSelector(command.options.selector, { timeout });
        }

        if (command.options.text) {
          await page.waitForFunction(
            (t) => document.body && document.body.innerText && document.body.innerText.includes(String(t)),
            command.options.text,
            { timeout }
          );
        }

        if (command.options.waitUrlContains) {
          await page.waitForURL((u) => u.toString().includes(command.options.waitUrlContains ?? ""), { timeout });
        }
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "wait",
          selector: command.options.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "wait", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "highlight") {
      const durationMs = command.options.durationMs;
      try {
        await page.evaluate(
          ({ selector, durationMs }) => {
            const el = document.querySelector(selector) as HTMLElement | null;
            if (!el) throw new Error(`No element matches selector: ${selector}`);
            const prevOutline = el.style.outline;
            const prevOutlineOffset = el.style.outlineOffset;
            el.style.outline = "3px solid #ff3b30";
            el.style.outlineOffset = "2px";
            setTimeout(() => {
              el.style.outline = prevOutline;
              el.style.outlineOffset = prevOutlineOffset;
            }, durationMs);
          },
          { selector: command.selector, durationMs }
        );
        await sleep(durationMs);
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "highlight",
          selector: command.selector,
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "highlight", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    if (command.kind === "resize") {
      try {
        await page.setViewportSize({ width: command.width, height: command.height });
      } catch (error) {
        throw await actionError(error, browser, command.options, {
          action: "resize",
          tabIndex,
          url: page.url()
        });
      }

      const payload = JSON.stringify({ ok: true }, null, 2);
      emit(command.options, { ok: true, action: "resize", tab: tabIndex, url: page.url() }, payload);
      return 0;
    }

    return 2;
  } finally {
    await cleanup();
  }
}

function emit(options: GlobalOptions, envelope: OutputEnvelope, legacyText?: string) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  if (legacyText === undefined) return;
  process.stdout.write(legacyText.endsWith("\n") ? legacyText : `${legacyText}\n`);
}

async function runAttempts(attempts: Attempt[]) {
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      await attempt.run();
      return;
    } catch (error) {
      if (error instanceof SkipAttemptError) {
        continue;
      }
      lastError = error;
    }
  }

  throw lastError ?? new Error("All fallback attempts failed");
}

async function runInChildFrames(page: any, runner: (frame: any) => Promise<void>) {
  const frames = page.frames().filter((f: any) => f !== page.mainFrame());
  if (frames.length === 0) {
    throw new SkipAttemptError("No child frames available");
  }

  let lastError: unknown;
  for (const frame of frames) {
    try {
      await runner(frame);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("No matching element found in child frames");
}

async function mouseDragBetween(page: any, source: any, target: any, timeout: number) {
  await source.scrollIntoViewIfNeeded({ timeout });
  await target.scrollIntoViewIfNeeded({ timeout });

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();

  if (!sourceBox || !targetBox) {
    throw new Error("Could not compute drag coordinates");
  }

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 12 });
  await page.mouse.up();
}

async function safeTitle(page: any): Promise<string | undefined> {
  try {
    return await page.title();
  } catch {
    return undefined;
  }
}

async function safeUserAgent(page: any): Promise<string | undefined> {
  try {
    return await page.evaluate(() => navigator.userAgent);
  } catch {
    return undefined;
  }
}

async function actionError(
  error: unknown,
  browser: any,
  options: GlobalOptions,
  details: { action: string; selector?: string; tabIndex: number; url: string }
): Promise<Error> {
  const message = error instanceof Error ? error.message : String(error);

  const context = await ensureContext(browser);
  const pages = listPages(context);
  const tabs = [] as Array<{ index: number; url: string; title?: string }>;
  for (let i = 0; i < pages.length; i++) {
    tabs.push({ index: i, url: pages[i].url(), title: await safeTitle(pages[i]) });
  }

  const selectorLine = details.selector ? `Selector: ${details.selector}\n` : "";
  const hint =
    `Selected tab: ${details.tabIndex}\n` +
    `Selected URL: ${details.url}\n` +
    selectorLine +
    `\nCommon causes:\n` +
    `- You're on a different tab/page than you think. Run: pw-control tabs list\n` +
    `  Then re-run with: --tab <index> or --tab-url-contains <text>\n` +
    `- The page isn't navigated yet. Run: pw-control navigate <url> ...\n` +
    `- The selector doesn't exist on this page (or is inside an iframe).\n` +
    `\nOpen tabs:\n` +
    tabs
      .slice(0, 10)
      .map((t) => `  [${t.index}] ${t.url}${t.title ? ` (${t.title})` : ""}`)
      .join("\n") +
    `\n`;

  const timeoutSuggestion = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const timeoutHint = `\nTip: increase timeout with --timeout-ms 60000 (current ${timeoutSuggestion}).\n`;

  return new Error(`pw-control: ${details.action} failed\n\n${message}\n\n${hint}${timeoutHint}`);
}

function safeStringify(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
