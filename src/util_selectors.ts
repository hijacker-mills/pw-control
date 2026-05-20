import { Page } from 'playwright-core';

export interface SmartSelectorOptions {
  timeout: number;
  maxTraversals?: number;
  tryCss?: boolean;
  tryText?: boolean;
  debug?: boolean;
}

export interface SelectorResult {
  success: boolean;
  selector?: string;
  selectorType?: 'original' | 'parent' | 'css' | 'xpath' | 'text';
  level?: number;
  clickable?: boolean;
  visible?: boolean;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
}

export function isLikelyCssSelector(selector: string): boolean {
  const trimmed = selector.trim();
  if (!trimmed) return false;
  if (trimmed.includes(">>")) return false;
  if (trimmed.startsWith("//") || trimmed.startsWith("..")) return false;
  const lower = trimmed.toLowerCase();
  const enginePrefixes = ["text=", "xpath=", "role=", "aria=", "id=", "css="];
  for (const prefix of enginePrefixes) {
    if (lower.startsWith(prefix)) return false;
  }
  return true;
}

export function isLikelyPlainText(selector: string): boolean {
  const trimmed = selector.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  const enginePrefixes = ["text=", "xpath=", "role=", "aria=", "id=", "css="];
  for (const prefix of enginePrefixes) {
    if (lower.startsWith(prefix)) return false;
  }
  // No obvious CSS selector characters or combinators.
  return !/[.#\[\]:>+~=*]/.test(trimmed);
}

export async function resolveSmartSelector(
  page: Page,
  originalSelector: string,
  options: SmartSelectorOptions
): Promise<SelectorResult> {
  const maxTraversals = options.maxTraversals || 3;
  const timeout = options.timeout;
  const debug = options.debug || false;

  // Try original selector first
  try {
    const element = await page.waitForSelector(originalSelector, {
      state: 'visible',
      timeout: Math.min(timeout / 2, 5000)
    });

    if (element) {
      const clickable = await isClickable(page, originalSelector);
      const boundingBox = await element.boundingBox();

      if (debug) {
        console.log(`Original selector "${originalSelector}" found. Clickable: ${clickable}`);
      }

      if (clickable) {
        return {
          success: true,
          selector: originalSelector,
          selectorType: 'original',
          clickable,
          visible: true,
          boundingBox
        };
      }
    }
  } catch (e) {
    if (debug) {
      console.log(`Original selector "${originalSelector}" failed: ${(e as Error).message}`);
    }
  }

  // Try parent traversal
  for (let level = 1; level <= maxTraversals; level++) {
    try {
      const parentSelector = await generateParentSelector(page, originalSelector, level);

      if (!parentSelector) {
        if (debug) console.log(`No parent found at level ${level}`);
        continue;
      }

      const element = await page.waitForSelector(parentSelector, {
        state: 'visible',
        timeout: Math.min(timeout / 3, 3000)
      });

      if (element) {
        const clickable = await isClickable(page, parentSelector);
        const boundingBox = await element.boundingBox();

        if (debug) {
          console.log(`Parent selector (level ${level}): "${parentSelector}" found. Clickable: ${clickable}`);
        }

        if (clickable) {
          return {
            success: true,
            selector: parentSelector,
            selectorType: 'parent',
            level,
            clickable,
            visible: true,
            boundingBox
          };
        }
      }
    } catch (e) {
      if (debug) {
        console.log(`Parent selector at level ${level} failed: ${(e as Error).message}`);
      }
    }
  }

  // Try alternative CSS selector strategies
  if (options.tryCss !== false) {
    try {
      const cssSelector = await generateCssSelector(page, originalSelector);
      if (cssSelector) {
        const element = await page.waitForSelector(cssSelector, {
          state: 'visible',
          timeout: Math.min(timeout / 3, 3000)
        });

        if (element) {
          const clickable = await isClickable(page, cssSelector);
          const boundingBox = await element.boundingBox();

          if (clickable) {
            return {
              success: true,
              selector: cssSelector,
              selectorType: 'css',
              clickable,
              visible: true,
              boundingBox
            };
          }
        }
      }
    } catch (e) {
      if (debug) console.log(`CSS selector generation failed: ${(e as Error).message}`);
    }
  }

  // Try text-based selector as last resort
  if (options.tryText !== false) {
    try {
      const textSelector = await generateTextSelector(page, originalSelector);
      if (textSelector) {
        const element = page.locator(textSelector).first();
        await element.waitFor({ state: 'visible', timeout: Math.min(timeout / 3, 3000) });

        const clickable = await element.isEnabled();
        const boundingBox = await element.boundingBox();

        if (clickable) {
          return {
            success: true,
            selector: textSelector,
            selectorType: 'text',
            clickable,
            visible: true,
            boundingBox
          };
        }
      }
    } catch (e) {
      if (debug) console.log(`Text selector generation failed: ${(e as Error).message}`);
    }
  }

  return { success: false };
}

async function isClickable(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;

    // Check if element is visible
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    // Check if element has zero dimensions
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    // Check if element or its ancestors have pointer-events: none
    let current: Element | null = el;
    while (current) {
      const currentStyle = window.getComputedStyle(current);
      if (currentStyle.pointerEvents === 'none') {
        return false;
      }
      current = current.parentElement;
    }

    // Check if element is covered by another element
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const elementAtPoint = document.elementFromPoint(centerX, centerY);
    if (!elementAtPoint) return false;

    return el.contains(elementAtPoint) || elementAtPoint.contains(el) || el === elementAtPoint;
  }, selector);
}

async function generateParentSelector(page: Page, selector: string, level: number): Promise<string | null> {
  return page.evaluate(
    (args) => {
      const { sel, lvl } = args;
      const el = document.querySelector(sel);
      if (!el) return null;

      // Traverse up the DOM tree
      let current: Element | null = el;
      for (let i = 0; i < lvl; i++) {
        if (current.parentElement) {
          current = current.parentElement;
        } else {
          return null;
        }
      }

      // Don't go all the way to body or html
      if (current.tagName === 'BODY' || current.tagName === 'HTML') {
        return null;
      }

      // Generate selector for the parent - prefer ID
      if (current.id) {
        return `#${CSS.escape(current.id)}`;
      }

      // Try with data-testid or other test attributes
      const testId = current.getAttribute('data-testid') || current.getAttribute('data-test-id');
      if (testId) {
        return `[data-testid="${testId}"]`;
      }

      // Try with classes if unique
      if (current.classList.length > 0) {
        const classSelector = `.${Array.from(current.classList).map(c => CSS.escape(c)).join('.')}`;
        if (document.querySelectorAll(classSelector).length === 1) {
          return classSelector;
        }
      }

      // Generate a more specific selector with tag + classes
      let path = current.tagName.toLowerCase();
      if (current.classList.length > 0) {
        path += `.${Array.from(current.classList).map(c => CSS.escape(c)).join('.')}`;
      }

      // Add nth-child if needed for uniqueness
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === current!.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          path += `:nth-of-type(${index})`;
        }
      }

      // Verify uniqueness
      if (document.querySelectorAll(path).length === 1) {
        return path;
      }

      // Add parent context for uniqueness
      if (parent && parent.id) {
        return `#${CSS.escape(parent.id)} > ${path}`;
      }

      return path;
    },
    { sel: selector, lvl: level }
  );
}

async function generateCssSelector(page: Page, originalSelector: string): Promise<string | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;

    const buildSelector = (element: Element): string | null => {
      // Try ID first
      if (element.id) {
        return `#${CSS.escape(element.id)}`;
      }

      // Try data-testid
      const testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id');
      if (testId) {
        return `[data-testid="${testId}"]`;
      }

      // Try with tag and classes
      const tag = element.tagName.toLowerCase();
      const classes = Array.from(element.classList)
        .map((c) => `.${CSS.escape(c)}`)
        .join('');

      // Check if tag+classes is unique
      const selector = `${tag}${classes}`;
      if (classes && document.querySelectorAll(selector).length === 1) {
        return selector;
      }

      // Add attributes that might help identify the element
      const attributes = ['name', 'type', 'role', 'aria-label', 'placeholder', 'title'];
      for (const attr of attributes) {
        if (element.hasAttribute(attr)) {
          const value = element.getAttribute(attr);
          const attrSelector = `${tag}[${attr}="${CSS.escape(value || '')}"]`;
          if (document.querySelectorAll(attrSelector).length === 1) {
            return attrSelector;
          }
        }
      }

      // Add parent context if needed
      if (element.parentElement && element.parentElement.tagName !== 'BODY') {
        const parentSelector = buildSelector(element.parentElement);
        if (parentSelector) {
          const childSelector = `${parentSelector} > ${tag}${classes}`;
          if (document.querySelectorAll(childSelector).length === 1) {
            return childSelector;
          }
        }
      }

      return null;
    };

    return buildSelector(el);
  }, originalSelector);
}

async function generateTextSelector(page: Page, originalSelector: string): Promise<string | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;

    // Get visible text content (direct text, not from children)
    const text = el.textContent?.trim();
    if (!text) return null;

    // If text is short enough and unique, use it directly
    if (text.length < 50 && text.length > 0) {
      // Check if this text is unique enough
      const matches = document.evaluate(
        `//*[contains(text(), "${text.replace(/"/g, '\\"')}")]`,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      if (matches.snapshotLength <= 3) {
        return `text="${text}"`;
      }
    }

    // Try with aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      return `[aria-label="${ariaLabel}"]`;
    }

    // Try with title
    const title = el.getAttribute('title');
    if (title) {
      return `[title="${title}"]`;
    }

    return null;
  }, originalSelector);
}

export function formatSelectorResult(result: SelectorResult): string {
  if (!result.success) {
    return 'No suitable selector found';
  }

  let output = `Found: ${result.selector} (${result.selectorType})`;

  if (result.selectorType === 'parent') {
    output += ` [parent level ${result.level}]`;
  }

  return output;
}
