# tChrome · Helm (驭舟)

[English](README.md) | [简体中文](README_zh.md)

**An autonomous AI partner steering, observing, operating, and preserving memory in your everyday Chrome browser.**

https://github.com/user-attachments/assets/a5b5e1a3-2cf6-4b94-9201-a52ef6cb4404

*Demo: Helm autonomously observing, planning, and solving multi-step complex interaction challenges (WebGames River Crossing benchmark) live in the daily Chrome browser.*

---

### Hello, I am Helm (驭舟)

I reside in your Chrome side panel, using your familiar real browser as my window to the web, connecting down to your local operating system and up to large language models.

I am not just a chatbot confined to a dialog box. I am an **autonomous browser agent capable of inspecting web pages, operating interactive controls, managing tabs, and orchestrating local files and terminal commands on your behalf**.

When collaborating with you, I adhere to the following principles:
- **Evidence-based, no assumptions**: I never guess page states. Every step is verified against the real DOM, accessibility tree, or screen captures. I decide the next move based on real feedback and never claim success without verification.
- **Goal-driven with clear hierarchy**: For complex, multi-step workflows, I decompose high-level goals into structured subgoals, ensuring explicit phase transitions and complete historical audit trails.
- **Memory-retaining, local-first**: Notes for temporary drafts, conversation memory for confirmed facts, project memory for long-term knowledge, and the Library for high-value URLs and credentials. All your session data, logs, screenshots, and library records are stored locally on your machine—completely open, inspectable, and under your control.

**tChrome** is my host framework (composed of **Chrome Extension + Local Bun Service + Model Provider**), and I—**Helm**—am the autonomous intelligence taking the helm, acting, and delivering results for you across the web.

---

## Capabilities

| Scenario | What You Can Entrust to Me |
| --- | --- |
| **Reading & In-Depth Synthesis** | Summarize page highlights, extract tables, cross-check information across tabs, and pinpoint critical details in long documents. |
| **Real Web Operations** | Open URLs, switch/group tabs, click, type, scroll, fill and submit forms, completing multi-step workflows based on feedback. |
| **Multi-Source Research & Fact-Checking** | Autonomously search the web, verify facts across source pages, and distill findings into structured reports or Library items. |
| **Frontend & Page Inspection** | Inspect DOM and accessibility trees, monitor element states, take visual screenshots, and execute in-page JavaScript for diagnostic debugging. |
| **Browser Environment Management** | Manage tabs and windows, track download progress, inspect cookies and page storage, and handle native browser dialogs. |
| **Local System Collaboration** | Read/write local files, search directories, execute shell scripts, manage background processes, and open files with system apps. |
| **Long-Term Asset Preservation** | Save curated websites, credentials, and reference notes directly into your local Library, with side panel search and inspection. |
| **Multi-Turn Continuous Evolution** | Seamlessly continue complex tasks in the same conversation, leverage conversation memory, and persist cross-session knowledge. |

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

### 1. Embedded in Your Real Workspace, Not an Isolated Headless Sandbox
I do not run in an isolated headless browser. I **operate directly inside your daily Chrome browser with your active logins, cookies, and browsing context**.
You can watch every click and keystroke in real time, or step in and take over whenever human intervention is needed. No fragile predefined workflows required for dynamic exploratory tasks.

### 2. Observable, Resilient Execution Loop
Driven by standardized tool calls, the Runtime manages queue scheduling, error handling, retries, state tracking, and circuit breakers.
The side panel transparently displays the **action reason** and **execution evidence** for each step. Tool execution failures are returned as objective feedback to the model for automated self-correction.

### 3. Dynamic, On-Demand Tool Discovery
Only core resident tools and discovery endpoints are injected at startup. Advanced browser operations, network probes, local file systems, and library capabilities are dynamically registered on demand.
This keeps prompt context minimal and token-efficient while making custom tool extensions straightforward.

### 4. Intelligent Context Compression with Lossless Raw Retrieval
When context approaches the threshold (200,000 characters), the Runtime schedules an independent **Compression Agent** to summarize previous turns into structured records (user goals, actions taken, objective outcomes).
Raw logs, tool arguments, and outputs remain intact on disk. When detailed verification is required, a **Query Agent** accurately retrieves original excerpts, preventing context bloat without losing fidelity.

### 5. Tiered Memory & Structured Library
| Tier | Purpose | Scope |
| --- | --- | --- |
| **Work Notes (`<notes>`)** | Ephemeral drafts, candidates, and intermediate work | Current session |
| **Conversation Memory (`<conversationMemory>`)** | Confirmed facts, user preferences, and key decisions | Preserved across turns in session |
| **Long-Term Memory (`<projectMemory>`)** | Shared conventions, background knowledge, and preferences | Globally shared across sessions |
| **Local Library** | Curated bookmarks, account credentials, and general references | Persistent local storage, side panel UI |

### 6. Local-First, Transparent & Controllable
Session logs, tool traces, screenshots, memories, and library items reside locally on your machine. System prompts, tool implementations, and adapters are open and auditable.
*(Note: Local-first refers to data ownership and storage; model inference sends necessary context to your chosen LLM provider.)*

---

## Comparison with Mainstream Alternatives

| Solution | Core Focus & Typical Usage | Best Fit | Trade-offs vs. tChrome / Helm |
| --- | --- | --- | --- |
| **Standard Chat Assistants** (ChatBot / Search AI) | Conversational Q&A, writing, search | Pure text generation and consulting without browser interaction | Helm specializes in **active browser operation, multi-step execution, and local system integration**; standard chatbots are simpler for text-only tasks. |
| **Browser Agent Frameworks** (e.g. browser-use) | Code-first Python/Node libraries | Developers building standalone custom browser agents | tChrome is ready to use out-of-the-box with a Chrome side panel, tiered memory, and local Library; frameworks are better suited as building blocks. |
| **Browser Automation** (Playwright / Puppeteer) | Fixed selectors, scripted action sequences, assertions | Deterministic regression testing, scrapers, rigid automation | Playwright excels at deterministic, predefined scripts; Helm thrives in **dynamic, ambiguous tasks requiring runtime visual and DOM observation**. |
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
│   └── tools/             # Browser host-side tool execution adapters
├── service/               # Local Bun core service
│   ├── runtime/           # Execution loop, scheduler, error handling, state machine
│   ├── context/           # Prompt composition, System rules, and section layout
│   ├── tools/             # Tool definitions, schema validation, registry
│   ├── agents/            # Specialized sub-agents (Compression & Query agents)
│   ├── memory/            # Tiered memory engine (conversation & project memory)
│   ├── library/           # Local persistent structured asset store
│   └── provider/          # LLM protocol adapters (OpenAI-compatible, etc.)
└── docs/                  # Protocol specifications and data architecture docs
```

---

## License & Community

Contributions, issues, and pull requests are welcome as we shape a more capable, intuitive autonomous browser agent!
