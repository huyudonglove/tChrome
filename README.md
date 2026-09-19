# tChrome · Helm (驭舟)

[English](README.md) | [简体中文](README_zh.md)

**An autonomous AI partner steering, observing, operating, and preserving memory in your everyday Chrome browser.**

https://github.com/user-attachments/assets/a5b5e1a3-2cf6-4b94-9201-a52ef6cb4404

*Demo: Helm autonomously observing, planning, and solving multi-step complex interaction challenges (WebGames River Crossing benchmark) live in the daily Chrome browser.*

---

### Hello, I am Helm (驭舟)

I reside in your Chrome side panel, using your familiar real browser as my window to the web, connecting down to your local operating system and up to large language models.

I am not just a chatbot confined to a dialog box. I am an **autonomous browser agent capable of inspecting web pages, operating interactive controls, managing tabs, perceiving host environments, and orchestrating local terminal commands on your behalf**.

When collaborating with you, I adhere to the following principles:
- **Evidence-based, no assumptions**: I never guess page states. Every step is grounded in the Chromium Accessibility (A11y) tree, rigorous state probes, or high-definition visual crop slices. I decide the next move based on real feedback and never claim success without verification.
- **Goal-driven with clear hierarchy**: For complex, multi-step workflows, I decompose high-level goals into structured subgoals, ensuring explicit phase transitions and complete historical audit trails.
- **Tiered cognition, local-first**: Notes for temporary drafts, conversation memory for confirmed facts, project memory for long-term knowledge, and the Library for high-value URLs and credentials. All your session data, logs, screenshots, and library records are stored locally on your machine—completely open, inspectable, and under your control.

**tChrome** is my host framework (composed of **Chrome Extension + Local Bun Service + Model Provider**), and I—**Helm**—am the autonomous intelligence taking the helm, acting, and delivering results for you across the web.

---

## Capabilities

| Scenario | What You Can Entrust to Me |
| --- | --- |
| **Reading & In-Depth Synthesis** | Summarize page highlights, extract tables, cross-check information across tabs, and pinpoint critical details in long documents. |
| **Full-Loop Web Operations** | Open URLs, switch/group tabs, execute precise click, type, and form submissions driven by the A11y semantic tree and compound tools with built-in network waits. |
| **Multi-Source Research & Fact-Checking** | Autonomously search the web, verify facts across source pages, and distill findings into structured reports or Library items. |
| **Frontend & Page Inspection** | Inspect Chromium accessibility trees, assert detailed element states (checked/expanded/invalid), capture crisp element crops, and execute diagnostic JavaScript. |
| **Host Environment Perception** | Bypass extension sandbox boundaries to inspect local Chrome profile preferences (memory saver exclusions, permission whitelists, silent download paths). |
| **Visual Tagging & Grounding** | Generate viewport Set-of-Marks (SoM) overlays for pure-graphics, Canvas, or dense control layouts, converting fuzzy coordinate regression into discrete choice. |
| **Local System Collaboration** | Read/write local files, search directories, execute shell scripts, manage background processes, and open files with system apps. |
| **Long-Term Asset Preservation** | Save curated websites, credentials, and reference notes directly into your local Library, with side panel search and inspection. |
| **Autonomous Long-Horizon Evolution** | Seamlessly compress long contexts via independent Compression and Query agents, persisting conversation facts and cross-session knowledge. |

### How You Can Prompt Me:

> "Inspect the current page, summarize key takeaways, and list any usage constraints or limitations."
>
> "Search for trending open-source WebGPU learning resources on GitHub, check their READMEs, extract highlights and star counts, and save the best to my Library."
>
> "Test the validation hints on this registration form under various boundary inputs, take screenshots of errors observed, and report back."
>
> "Record our confirmed configuration items into conversation memory, then proceed to analyze the second architectural option."

---

## Core Engineering & Design Advantages

### 1. Embedded in Your Real Workspace, Not an Isolated Headless Sandbox (Real Chrome Workspace)
I do not run in an isolated headless browser. I **operate directly inside your daily Chrome browser with your active logins, cookies, and browsing context**.
You can watch every click and keystroke in real time, or step in and take over whenever human intervention is needed. No fragile predefined workflows required for dynamic exploratory tasks.

### 2. Pure Accessibility-First Semantic Full Loop (Accessibility-First Architecture)
Traditional browser automation relies on fragile DOM CSS selectors, brittle XPath queries, or expensive pure-vision coordinate clicks that break with every UI redesign. tChrome pivots entirely to the Chromium core Accessibility (A11y) tree:
- **Physical Noise Elimination**: Strips away thousands of unstyled `<div>` tags and decorative clutter, distilling interfaces purely into `Role`, `Name`, and `States`. This boosts context signal-to-noise ratio and slashes token consumption by over 80%.
- **Rigorous Full-Loop Tooling**:
  - **Perception**: `page.list_interactive_elements` projects interactive elements in the viewport with normalized roles, accessible names, and fine-grained state flags (`enabled`, `checked`, `expanded`, `selected`, etc.);
  - **Synchronization**: `wait` natively supports conditional waiting on `role + name + states`, eliminating arbitrary sleep timeouts;
  - **Interaction**: `page.click_role`, `page.fill_role`, and `page.select_role` hit targets reliably in one trip;
  - **Verification**: `page.assert` and `page.recheck` verify precise post-action states (e.g. verifying that a modal has closed via `expanded=false` or an input is valid via `invalid=false`), forming an unbroken chain of evidence.

### 3. Dual-Track Host Environment Perception (Host Environment Perception)
When the browser extension sandbox restricts access to privileged internal pages like `chrome://settings`, tChrome seamlessly switches to the **host physical machine perspective**:
- Direct read access to local Chrome configuration files (`Preferences` and `Local State` JSON across macOS, Linux, and Windows) via native service tools;
- Audits and monitors **Memory Saver (High Efficiency Mode)** tab sleep exemptions, **site permission whitelists (popups / clipboard access)**, and **silent download paths**, eliminating blind spots and marrying host-level awareness with browser internals.

### 4. Hybrid Vision-DOM Engine (Adaptive Visual Grounding)
Unlike Computer Use architectures that capture and stream full-screen high-res frames on every single step—causing bandwidth spikes, token bloat, and visual attention fatigue—tChrome adopts an efficient "Semantics-First, Targeted Vision on Demand" philosophy:
- **High-Definition Crop on Demand**: `capture_page(mode="element", ref=...)` captures only the target element slice, saving over 90% in visual tokens while rendering tiny text and dense charts crystal-clear;
- **Set-of-Marks (SoM) Grounding**: `capture_page(mode="som")` injects discrete numerical badges over interactive controls on graphical Canvas or dense layouts, transforming error-prone coordinate regression into reliable discrete classification;
- **Ephemeral Frame Management**: Newly captured frames accompany only the immediate subsequent model call, automatically downgrading to local disk paths in historical turns to prevent context exhaustion.

### 5. High-Frequency Compound Tools, Halving Round-Trips
Interacting with complex web forms previously required multiple model round-trips to click, enter text, submit, and wait for async API responses. tChrome introduces atomic compound tools:
- `page.click_role` / `page.click_text`: A11y role or visible text targeting + automatic click + expected response/text wait in a single step;
- `page.fill_role` / `page.select_role`: Smart element targeting followed immediately by text entry or option selection;
- `page.submit_wait` / `page.fill_submit`: Batch form population combined with network response interception (`wait_response`).
This cuts interaction latency and token overhead by more than 50% while eliminating race conditions at the protocol level.

### 6. Deterministic State Bus & 4,000-Character Guardrail (Context Assembly)
tChrome abandons fragile single-prompt concatenation and generic linear message lists:
- **Layered Assembly Bus**: Strictly decouples immutable System semantic contracts from dynamic User state slots (Goal / Checklist / Notes / Memory / ToolIO), dynamically assembled per turn;
- **4,000-Character Inline Safety Guardrail**: All single tool outputs and large page observations pass through a 4,000-character inline check. Over-limit content is externalized to disk with fixed line widths, allowing the agent to retrieve exact excerpts or line windows via `evidence.search`, physically preventing prompt pollution and context overflow;
- **Structured Monotonic Short IDs**: Persistent IDs (`call_01`, `e_01`, `proc_01`) prevent hallucinated identifiers from breaking tool execution chains.

### 7. Interactive Widgets & Dual-Track Sandbox (Interactive Widgets)
Due to Chrome's strict extension Content Security Policy (CSP), inline JavaScript is prohibited in the side panel. tChrome implements a dual-track interactive presentation layer:
- **Declarative Scriptless Interactivity**: Declarative HTML attributes (`data-action="pick"`, `data-action="count"`, `data-copy`) provide instant UI state toggling and copying without executing JavaScript;
- **Isolated Widget Sandbox (`<tchrome-widget>`)**: Complex mini-apps (interactive calculators, dynamic charts, self-contained mini-games) are served via a local independent sandbox iframe outside extension CSP restrictions, ensuring both extension security and full-featured web app capabilities.

### 8. Lossless Context Compression & Query Agent
When context approaches the threshold (200,000 characters), the Runtime invokes an independent **Compression Agent** to distill historical turns into structured records (user goals, actions taken, objective outcomes).
Raw interaction logs and tool arguments remain intact on disk. When deep verification is needed, an independent **Query Agent** retrieves original excerpts on demand, controlling token costs without sacrificing historical fidelity.

### 9. Tiered Cognitive Architecture & Structured Library
| Tier | Purpose | Scope |
| --- | --- | --- |
| **Execution Checklist (`<checklist>`)** | Step breakdown and real-time execution tracking for the current turn | Current turn only; cleared upon completion |
| **Work Notes (`<notes>`)** | Ephemeral drafts, candidates, and working scratchpad | Preserved across turns in current session |
| **Conversation Memory (`<conversationMemory>`)** | Confirmed facts, user preferences, and key architectural decisions | Preserved across turns in current session |
| **Long-Term Memory (`<projectMemory>`)** | Shared domain conventions, environmental preferences, and persistent facts | Globally shared across all sessions |
| **Local Library** | Curated bookmarks, account credentials, and general references | Persistent local storage, side panel UI |

### 10. Local-First, Transparent & Controllable
Session logs, tool traces, screenshots, memories, and library items reside locally on your machine. System prompts, tool implementations, and adapters are open and auditable.
*(Note: Local-first refers to data ownership and storage; model inference sends necessary context to your chosen LLM provider.)*

---

## Comparison with Mainstream Alternatives

| Solution | Core Focus & Typical Usage | Best Fit | Trade-offs vs. tChrome / Helm |
| --- | --- | --- | --- |
| **Standard Chat Assistants** (ChatBot / Search AI) | Conversational Q&A, writing, search | Pure text generation and consulting without browser interaction | Helm specializes in **active browser operation, multi-step execution, and local system integration**; standard chatbots are simpler for text-only tasks. |
| **Browser Agent Frameworks** (e.g. browser-use) | Code-first Python/Node libraries | Developers building standalone custom browser agents | tChrome is ready to use out-of-the-box with a Chrome side panel, A11y full-loop, tiered memory, and local Library; frameworks are better suited as building blocks. |
| **Pure-Vision Computer Use** | Screen capture, mouse coordinate clicking | Desktop OS apps, closed-source desktop software | Pure-vision approaches suffer from heavy token and latency costs; Helm prioritizes **A11y semantic trees, with targeted SoM and crop slices on demand**, delivering vastly superior speed and reliability. |
| **Browser Automation** (Playwright / Puppeteer) | Fixed selectors, scripted action sequences, assertions | Deterministic regression testing, scrapers, rigid automation | Playwright excels at deterministic, predefined scripts; Helm thrives in **dynamic, ambiguous tasks requiring runtime visual and A11y observation**. |
| **Workflow Platforms** (n8n / Dify) | Node-based workflows, API orchestration, automated pipelines | Cross-enterprise system integrations and backend automation | Workflow platforms focus on backend services; Helm focuses on **desktop-level, immersive real-time collaboration in your daily browser**. |

---

## Quick Start & Installation

### Prerequisites
- **Google Chrome 135+**
- **[Bun](https://bun.sh/)** for dependency management, extension builds, and the local service.

> *Default file paths and native features are optimized for macOS; core features also run on Linux and Windows.*

### 1. Clone & Install
```bash
git clone https://github.com/huyudonglove/tChrome.git
cd tChrome
bun install
```

### 2. Build & Launch Service
```bash
bun run build
bun run service
```
The local service listens on `http://127.0.0.1:18788`. Check `http://127.0.0.1:18788/health` to verify connectivity.

### 3. Load Chrome Extension
1. Open Chrome and navigate to `chrome://extensions/`. Enable **"Developer mode"** in the top right.
2. Click **"Load unpacked"** and select the project's **`dist/`** directory.
3. Open any webpage and click the tChrome icon in your toolbar to open the side panel.
4. Configure your model API Key and endpoint in the settings, and start collaborating with Helm!

---

## Project Structure

```text
tChrome/
├── extension/             # Chrome side panel frontend (React + Tailwind)
│   ├── sidepanel/         # Side panel UI, Library management interface
│   └── tools/             # Browser host-side tool execution adapters (A11y projection & CDP)
├── service/               # Local Bun core service
│   ├── runtime/           # Execution loop, scheduler, error handling, state machine
│   ├── context/           # Prompt composition, System rules, and section layout (4000 guardrail)
│   ├── tools/             # Tool definitions, schema validation, registry (A11y & compound tools)
│   ├── skills/            # Domain skills & operational runbooks (Web observation, host env)
│   ├── agents/            # Specialized sub-agents (Compression & Query agents)
│   ├── memory/            # Tiered memory engine (conversation & project memory)
│   ├── library/           # Local persistent structured asset store
│   └── provider/          # LLM protocol adapters (OpenAI-compatible, etc.)
└── docs/                  # Protocol specifications and data architecture docs
```

---

## License & Community

Contributions, issues, and pull requests are welcome as we shape a more capable, intuitive autonomous browser agent!
