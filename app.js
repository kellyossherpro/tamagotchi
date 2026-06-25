/*
  app.js — the BRAIN of the game.
  This file is the rules and behavior. It:
    - loads and saves your pet and todos in your browser
    - draws the right pet on screen
    - handles adding/checking/deleting tasks
    - feeds + heals the pet when you finish tasks
    - drains hunger and happiness over time (weekdays only)
    - hibernates on weekends
    - evolves the pet when you've earned it
    - handles death and starting over

  It's commented heavily so you can read it like a story.
*/

// ============================================================
// 1) CONSTANTS — the numbers that control the game.
//    Tweak these to make the game easier/harder.
// ============================================================

const STORAGE_KEY = "cerb-tamagotchi-v1"; // where we save in the browser

// XP rewards for each difficulty (matches the buttons in the HTML)
// Decay rate: 50 points per 24h on weekdays
const DECAY_PER_MS = 50 / (24 * 60 * 60 * 1000);
const HUNGRY_THRESHOLD = 30; // below this, happiness drops 50% faster
const HUNGRY_SAD_MULTIPLIER = 1.5;

// Reward for completing one task (added on top of the XP)
const FEED_HUNGER = 20;
const FEED_HAPPINESS = 15;

// Big bonus feed when Penny eats the biscuit (i.e. an evolution fires)
const BISCUIT_FEED_HUNGER = 40;
const BISCUIT_FEED_HAPPINESS = 35;

// How often the running game tick fires while the page is open (ms).
// We update visuals once a second; actual decay math is time-based,
// not tick-based, so this isn't a precision number.
const TICK_MS = 1000;

// The six evolution stages. Each needs BOTH weekdays survived AND total XP.
const STAGES = [
  { name: "Egg",             daysNeeded: 0,  xpNeeded: 0   },
  { name: "Blob",            daysNeeded: 1,  xpNeeded: 30  },
  { name: "1-headed pup",    daysNeeded: 3,  xpNeeded: 80  },
  { name: "2-headed pup",    daysNeeded: 6,  xpNeeded: 180 },
  { name: "3-headed pup",    daysNeeded: 10, xpNeeded: 320 },
  { name: "Big Cerberus",    daysNeeded: 15, xpNeeded: 500 },
];

// ============================================================
// 2) STATE — the data we keep about the pet and todos.
//    This whole object gets saved into the browser's storage
//    so refreshing the page doesn't lose anything.
// ============================================================

function freshState() {
  return {
    pet: {
      name: "",                   // empty means we'll ask for a name
      hunger: 100,                // 0–100
      happiness: 100,             // 0–100
      xp: 0,                      // total XP earned ever (this life)
      stageIndex: 0,              // index into STAGES
      survivedWeekdays: 0,        // how many weekdays counted as "survived"
      tasksDoneEver: 0,           // for the gravestone stat
      alive: true,
      // The XP total at the last evolution. Used to draw the biscuit:
      // progress toward next evolution = (xp - xpAtLastEvolution) / (nextThreshold - xpAtLastEvolution)
      xpAtLastEvolution: 0,
    },
    todos: [],                    // list of { id, text, xp, difficulty, done }
    // Time bookkeeping:
    lastSeen: Date.now(),         // when the page was last open
    lastDayKey: dayKey(new Date()),
    tasksCompletedToday: 0,
  };
}

let state = loadState();

// ============================================================
// 3) STORAGE HELPERS — read and write the state to the browser.
// ============================================================

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    // tiny safety net: if storage is from a future broken version, reset.
    if (!parsed.pet || !parsed.todos) return freshState();
    return parsed;
  } catch (e) {
    return freshState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ============================================================
// 4) DATE HELPERS — for weekday detection and day tracking.
// ============================================================

// dayKey turns a Date into a string like "2026-06-19".
// We use this to detect when a new day has started.
function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

// isWeekend: Saturday (6) or Sunday (0) in the user's local time.
function isWeekend(date) {
  const d = date.getDay();
  return d === 0 || d === 6;
}

// weekdayMillisBetween: how many milliseconds of "awake time" passed
// between two timestamps, only counting weekday hours.
// Used for catching up on decay when you've been away.
function weekdayMillisBetween(startMs, endMs) {
  if (endMs <= startMs) return 0;
  let total = 0;
  let cursor = startMs;
  // walk forward in 1-hour chunks; cheap and easy to reason about.
  const HOUR = 60 * 60 * 1000;
  while (cursor < endMs) {
    const next = Math.min(cursor + HOUR, endMs);
    if (!isWeekend(new Date(cursor))) {
      total += next - cursor;
    }
    cursor = next;
  }
  return total;
}

// ============================================================
// 5) GAME LOGIC — what happens when time passes or tasks finish.
// ============================================================

// daysBetween: how many full calendar days from one YYYY-MM-DD to another.
// Used for overdue task XP penalty.
function daysBetween(fromKey, toKey) {
  const a = new Date(fromKey + "T00:00:00");
  const b = new Date(toKey + "T00:00:00");
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

// Apply -1 XP per day overdue to every unfinished task with a due date.
// Catches up if you've been away — e.g. 3 days overdue when you reopen
// applies the full -3 in one go. Task XP never drops below 0.
function applyOverdueLosses() {
  const todayKey = dayKey(new Date());
  state.todos.forEach(todo => {
    if (todo.done) return;
    if (!todo.dueDate) return;
    const overdueDays = Math.max(0, daysBetween(todo.dueDate, todayKey));
    const applied = todo.overdueLossApplied || 0;
    const toApply = overdueDays - applied;
    if (toApply > 0) {
      todo.xp = Math.max(0, (todo.xp || 0) - toApply);
      todo.overdueLossApplied = overdueDays;
    }
  });
}

// Catch up: called on page load AND every tick.
// Applies decay for the time since we last looked.
function applyTimePassage() {
  const now = Date.now();
  const elapsedWeekdayMs = weekdayMillisBetween(state.lastSeen, now);

  if (elapsedWeekdayMs > 0 && state.pet.alive) {
    // Decay hunger
    state.pet.hunger = Math.max(0, state.pet.hunger - elapsedWeekdayMs * DECAY_PER_MS);
    // Happiness decays too, faster if hungry
    const sadMultiplier = state.pet.hunger < HUNGRY_THRESHOLD ? HUNGRY_SAD_MULTIPLIER : 1;
    state.pet.happiness = Math.max(0, state.pet.happiness - elapsedWeekdayMs * DECAY_PER_MS * sadMultiplier);
  }

  // Detect day rollover. If today is a new day:
  //  - If the previous day was a weekday, was the pet alive AND tasksCompletedToday >= 1?
  //    -> count it as a survived weekday.
  //  - Reset tasksCompletedToday for today.
  const todayKey = dayKey(new Date(now));
  if (todayKey !== state.lastDayKey) {
    const prevDate = new Date(state.lastDayKey + "T12:00:00");
    if (!isWeekend(prevDate) && state.pet.alive && state.tasksCompletedToday >= 1) {
      state.pet.survivedWeekdays += 1;
    }
    state.tasksCompletedToday = 0;
    state.lastDayKey = todayKey;
  }

  state.lastSeen = now;

  // Check death (both bars hit 0)
  if (state.pet.alive && state.pet.hunger <= 0 && state.pet.happiness <= 0) {
    state.pet.alive = false;
  }

  // Apply overdue penalties for any unfinished tasks past their due date.
  applyOverdueLosses();

  // Check evolution (level up if BOTH thresholds met).
  // When evolution fires, Penny "eats the biscuit": big feed + happiness bonus,
  // and we record the new XP baseline so the biscuit resets to greyscale.
  while (state.pet.stageIndex < STAGES.length - 1) {
    const next = STAGES[state.pet.stageIndex + 1];
    if (state.pet.survivedWeekdays >= next.daysNeeded && state.pet.xp >= next.xpNeeded) {
      state.pet.stageIndex += 1;
      state.pet.hunger = Math.min(100, state.pet.hunger + BISCUIT_FEED_HUNGER);
      state.pet.happiness = Math.min(100, state.pet.happiness + BISCUIT_FEED_HAPPINESS);
      state.pet.xpAtLastEvolution = next.xpNeeded;
    } else {
      break;
    }
  }
}

// When you tick a task: mark it done. If this is the FIRST time this
// task has ever been ticked, also award XP + feed the pet. The `awarded`
// flag means you can uncheck and re-check without farming points.
function completeTask(todo) {
  if (!state.pet.alive) return;
  todo.done = true;
  if (!todo.awarded) {
    todo.awarded = true;
    state.pet.hunger = Math.min(100, state.pet.hunger + FEED_HUNGER);
    state.pet.happiness = Math.min(100, state.pet.happiness + FEED_HAPPINESS);
    state.pet.xp += todo.xp;
    state.pet.tasksDoneEver += 1;
    state.tasksCompletedToday += 1;
  }
  applyTimePassage(); // re-check evolution
  saveState();
  render();
}

function uncompleteTask(todo) {
  // Allow unchecking — but XP / feed already awarded stays awarded.
  if (todo.done) {
    todo.done = false;
    saveState();
    render();
  }
}

function addTodo(text, xp, difficulty, dueDate, description, link) {
  const trimmed = text.trim();
  if (!trimmed) return;
  state.todos.unshift({
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    text: trimmed,
    xp,
    difficulty,
    done: false,
    awarded: false,
    dueDate: dueDate || null,            // "YYYY-MM-DD" or null
    overdueLossApplied: 0,               // total XP already deducted for lateness
    description: (description || "").trim(),
    link: (link || "").trim(),
  });
  saveState();
  render();
}

function deleteTodo(id) {
  state.todos = state.todos.filter(t => t.id !== id);
  saveState();
  render();
}

// ----- PAGINATION -----
// Active to-do list pages every 10 items; the completed list (which is
// collapsed by default and lives in a narrower column) pages every 5.
const ACTIVE_PAGE_SIZE = 10;
const DONE_PAGE_SIZE   = 5;
// In-memory only — paging doesn't need to survive a reload.
let activePage = 0;
let donePage = 0;

function updatePager(wrapId, prevId, nextId, infoId, page, totalPages) {
  const wrap = document.getElementById(wrapId);
  wrap.classList.toggle("hidden", totalPages <= 1);
  document.getElementById(infoId).textContent = `${page + 1} / ${totalPages}`;
  document.getElementById(prevId).disabled = page <= 0;
  document.getElementById(nextId).disabled = page >= totalPages - 1;
}

// Editing state lives in memory only (not saved):
// - editingId: which todo (if any) is currently being edited (null = none)
// - editingDraft: the in-progress values being typed; survives re-renders so
//   the 1-second tick doesn't wipe your input
// - editingJustStarted: focus the text input only on the first render after
//   startEdit (so clicking the date picker doesn't get focus-stolen)
let editingId = null;
let editingDraft = null;
let editingJustStarted = false;

function startEdit(id) {
  const todo = state.todos.find(t => t.id === id);
  if (!todo) return;
  editingId = id;
  editingDraft = {
    text: todo.text,
    xp: todo.xp,
    difficulty: todo.difficulty,
    dueDate: todo.dueDate || "",
    description: todo.description || "",
    link: todo.link || "",
  };
  editingJustStarted = true;
  render();
}

function cancelEdit() {
  editingId = null;
  editingDraft = null;
  render();
}

function saveEdit() {
  if (!editingId || !editingDraft) return;
  const todo = state.todos.find(t => t.id === editingId);
  if (!todo) return;
  const trimmed = (editingDraft.text || "").trim();
  if (!trimmed) return; // ignore empty saves
  todo.text = trimmed;
  todo.xp = editingDraft.xp;
  todo.difficulty = editingDraft.difficulty;
  todo.description = (editingDraft.description || "").trim();
  todo.link = (editingDraft.link || "").trim();
  const newDue = editingDraft.dueDate || null;
  // If the due date is changed, reset overdue tracking so the new date is
  // treated as fresh.
  if (newDue !== (todo.dueDate || null)) {
    todo.dueDate = newDue;
    todo.overdueLossApplied = 0;
  }
  editingId = null;
  editingDraft = null;
  saveState();
  render();
}

// Soft reset: new egg, todos preserved (we promised).
function reviveAsEgg() {
  const oldTodos = state.todos;
  const oldName = state.pet.name;
  state = freshState();
  state.todos = oldTodos;
  state.pet.name = oldName;
  saveState();
  render();
}

// ----- SETTINGS RESETS -----
// All three reset options below show a confirm() with explicit text describing
// exactly what will happen, so nothing is wiped by accident.

// Reset the pet: new egg, stats reset, days reset. Tasks are NOT touched.
function resetPetOnly() {
  const ok = confirm(
    "RESET THE PET\n\n" +
    "Your pet will become a fresh egg.\n" +
    "XP, days survived, hunger and happiness all reset to the start.\n" +
    "Your tasks STAY exactly as they are (done tasks stay done).\n\n" +
    "Continue?"
  );
  if (!ok) return;
  const keptTodos = state.todos;
  const keptName = state.pet.name;
  state = freshState();
  state.todos = keptTodos;
  state.pet.name = keptName;
  saveState();
  closeSettings();
  render();
}

// Reset XP: XP to 0, stage back to egg. Days/hunger/happiness kept.
// Tasks are re-armed so they can be used to earn XP again.
function resetXp() {
  const ok = confirm(
    "RESET XP\n\n" +
    "XP goes back to 0 and the pet goes back to an egg.\n" +
    "Days survived, hunger and happiness STAY where they are.\n" +
    "All tasks will be unticked and re-armed so you can earn XP again.\n\n" +
    "Continue?"
  );
  if (!ok) return;
  state.pet.xp = 0;
  state.pet.stageIndex = 0;
  state.pet.xpAtLastEvolution = 0;
  state.todos = state.todos.map(t => ({ ...t, done: false, awarded: false }));
  saveState();
  closeSettings();
  render();
}

// Reset tasks: every task becomes unticked + awarded cleared. Pet untouched.
function resetTasks() {
  const ok = confirm(
    "RESET ALL TASKS\n\n" +
    "Every task will be unticked and re-armed for XP.\n" +
    "The pet, its stats and its stage are NOT touched.\n\n" +
    "Continue?"
  );
  if (!ok) return;
  state.todos = state.todos.map(t => ({ ...t, done: false, awarded: false }));
  saveState();
  closeSettings();
  render();
}

// ----- SETTINGS OPEN/CLOSE -----
function openSettings() {
  document.getElementById("settingsOverlay").classList.remove("hidden");
}
function closeSettings() {
  document.getElementById("settingsOverlay").classList.add("hidden");
}

// ============================================================
// 6) NAMING — ask for a name on first run, allow rename anytime.
// ============================================================

function promptForName() {
  const suggestion = state.pet.name || "Cerb";
  const name = prompt("Name your pet:", suggestion);
  if (name && name.trim()) {
    state.pet.name = name.trim().slice(0, 24);
    saveState();
    render();
  }
}

// ============================================================
// 7) SVG DRAWINGS — one per evolution stage.
//    These are simple inline SVGs. Want a different pet?
//    Ask AI: "redraw stage 4 to give it bigger ears" or similar.
// ============================================================

// Each stage now renders as a real PNG image. The animations (jiggle,
// chomp, hatchPop, evolution flash) animate the .pet-stage div, so they
// work on the <img> just as they did on the inline SVG.
const SVGS = {
  0: `<img src="stage_0_egg.png" alt="Egg" draggable="false" />`,
  1: `<img src="stage_1_blob.png" alt="Blob" draggable="false" />`,
  2: `<img src="stage_2_pup1.png" alt="1-headed pup" draggable="false" />`,
  3: `<img src="stage_3_pup2.png" alt="2-headed pup" draggable="false" />`,
  4: `<img src="stage_4_pup3.png" alt="3-headed pup" draggable="false" />`,
  5: `<img src="stage_5_cerberus.png" alt="Big Cerberus" draggable="false" />`,
};

// ============================================================
// 8) RENDER — paint the screen from the current state.
//    Called whenever something changes.
// ============================================================

// Track what we last drew for the pet so we don't reinject the SVG every
// tick. That reinjection used to wipe in-flight wiggle/heart animations.
let lastDrawnStageKey = "";

function render() {
  // Pet name
  document.getElementById("petName").textContent = state.pet.name || "Your Pet";

  // Pet SVG (or gravestone if dead) — only redraw when the stage or
  // alive state actually changes.
  const petStage = document.getElementById("petStage");
  const stageKey = state.pet.alive ? `alive:${state.pet.stageIndex}` : "dead";
  if (stageKey !== lastDrawnStageKey) {
    // Detect whether this change is an evolution (alive -> bigger alive),
    // as opposed to the first render after load, a revive, or a death.
    const prev = lastDrawnStageKey;
    const isEvolution =
      prev.startsWith("alive:") &&
      stageKey.startsWith("alive:") &&
      parseInt(stageKey.slice(6), 10) > parseInt(prev.slice(6), 10);

    if (!state.pet.alive) {
      petStage.innerHTML = `<div style="font-size:120px">🪦</div>`;
    } else {
      petStage.innerHTML = SVGS[state.pet.stageIndex] || SVGS[0];
    }
    lastDrawnStageKey = stageKey;

    if (isEvolution) playEvolutionAnimation();
  }

  // Mood overlay
  const mood = document.getElementById("moodOverlay");
  if (isWeekend(new Date())) {
    mood.textContent = "💤"; // hibernating
  } else if (!state.pet.alive) {
    mood.textContent = "";
  } else if (state.pet.hunger < HUNGRY_THRESHOLD || state.pet.happiness < HUNGRY_THRESHOLD) {
    mood.textContent = "😢";
  } else if (state.pet.hunger > 80 && state.pet.happiness > 80) {
    mood.textContent = "✨";
  } else {
    mood.textContent = "";
  }

  // Stat bars + their numeric labels + hover-tooltip explanations
  setBar("hungerFill", state.pet.hunger);
  setBar("happinessFill", state.pet.happiness);
  updateStatLabel("hungerStat", "hungerValue", state.pet.hunger, buildHungerTooltip());
  updateStatLabel("happinessStat", "happinessValue", state.pet.happiness, buildHappinessTooltip());

  // Meta
  document.getElementById("stageLabel").textContent = STAGES[state.pet.stageIndex].name;
  document.getElementById("xpLabel").textContent = Math.floor(state.pet.xp);
  document.getElementById("daysLabel").textContent = state.pet.survivedWeekdays;

  // Biscuit — colour saturation reflects XP progress to next evolution.
  renderBiscuit();

  // Todo list — split into active (not done) and done.
  // If we're in the middle of an edit AND this is just the 1-second
  // background tick (not a real user action), skip rebuilding the lists
  // entirely. Rebuilding would tear down the open date picker.
  if (editingId && isTickRender) return;

  const list = document.getElementById("todoList");
  const doneList = document.getElementById("doneList");
  list.innerHTML = "";
  doneList.innerHTML = "";
  const allActive = state.todos.filter(t => !t.done);
  const allDone   = state.todos.filter(t => t.done);

  // Pagination: clamp pages to valid range, then slice for rendering.
  const activePages = Math.max(1, Math.ceil(allActive.length / ACTIVE_PAGE_SIZE));
  const donePages   = Math.max(1, Math.ceil(allDone.length   / DONE_PAGE_SIZE));
  activePage = Math.min(activePage, activePages - 1);
  donePage   = Math.min(donePage,   donePages   - 1);
  const activeTodos = allActive.slice(activePage * ACTIVE_PAGE_SIZE, (activePage + 1) * ACTIVE_PAGE_SIZE);
  const doneTodos   = allDone.slice(donePage   * DONE_PAGE_SIZE,   (donePage   + 1) * DONE_PAGE_SIZE);

  // Render the pager controls (or hide them if only one page).
  updatePager("activePager", "activePrev", "activeNext", "activePageInfo", activePage, activePages);
  updatePager("donePager",   "donePrev",   "doneNext",   "donePageInfo",   donePage,   donePages);

  // Render active todos in the main list; done todos in the side list.
  activeTodos.concat(doneTodos).forEach(todo => {
    // Which list does this row belong in?
    const targetList = todo.done ? doneList : list;
    const li = document.createElement("li");

    // EDIT MODE — show input + description + link + due date + difficulty picker + save/cancel.
    if (todo.id === editingId && !todo.done) {
      li.className = "todo-item editing";
      li.innerHTML = `
        <input type="text" class="edit-input" maxlength="120" />
        <textarea class="edit-desc" rows="2" maxlength="500" placeholder="Description (optional)"></textarea>
        <input type="url" class="edit-link" placeholder="Link (optional) — https://…" />
        <div class="edit-actions">
          <input type="date" class="edit-due" />
          <div class="edit-diff-row">
            <button class="diff-mini normal" data-xp="5" data-diff="normal">5</button>
            <button class="diff-mini medium" data-xp="10" data-diff="medium">10</button>
            <button class="diff-mini hard" data-xp="20" data-diff="hard">20</button>
          </div>
          <button class="save-edit" title="Save">✓</button>
          <button class="cancel-edit" title="Cancel">×</button>
        </div>
      `;
      const textInput = li.querySelector(".edit-input");
      const descInput = li.querySelector(".edit-desc");
      const linkInput = li.querySelector(".edit-link");
      const dueInput = li.querySelector(".edit-due");
      textInput.value = editingDraft.text;
      descInput.value = editingDraft.description || "";
      linkInput.value = editingDraft.link || "";
      dueInput.value = editingDraft.dueDate || "";
      const diffBtns = li.querySelectorAll(".diff-mini");
      const highlight = () => diffBtns.forEach(b =>
        b.classList.toggle("active", b.dataset.diff === editingDraft.difficulty)
      );
      highlight();
      diffBtns.forEach(b => b.addEventListener("click", () => {
        editingDraft.xp = parseInt(b.dataset.xp, 10);
        editingDraft.difficulty = b.dataset.diff;
        highlight();
      }));
      // Keep the draft in sync as you type / pick a date.
      textInput.addEventListener("input", (e) => { editingDraft.text = e.target.value; });
      descInput.addEventListener("input", (e) => { editingDraft.description = e.target.value; });
      linkInput.addEventListener("input", (e) => { editingDraft.link = e.target.value; });
      dueInput.addEventListener("input", (e) => { editingDraft.dueDate = e.target.value; });
      dueInput.addEventListener("change", (e) => { editingDraft.dueDate = e.target.value; });
      li.querySelector(".save-edit").addEventListener("click", saveEdit);
      li.querySelector(".cancel-edit").addEventListener("click", cancelEdit);
      textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveEdit();
        if (e.key === "Escape") cancelEdit();
      });
      // Auto-focus the text input ONLY on the first render after startEdit;
      // otherwise the 1-second tick re-render would steal focus from the
      // date picker every time the user tried to click it.
      if (editingJustStarted) {
        editingJustStarted = false;
        setTimeout(() => textInput.focus(), 0);
      }
      targetList.appendChild(li);
      return;
    }

    // NORMAL MODE
    // Compute due-date label and whether this task is overdue today.
    const todayKey = dayKey(new Date());
    const isOverdue = !todo.done && todo.dueDate && todo.dueDate < todayKey;
    const isDueToday = !todo.done && todo.dueDate && todo.dueDate === todayKey;
    let dueLabel = "";
    if (todo.dueDate) {
      const overdueDays = Math.max(0, daysBetween(todo.dueDate, todayKey));
      if (isOverdue) {
        dueLabel = `<span class="due-tag overdue">${overdueDays}d overdue · −${overdueDays} XP</span>`;
      } else if (isDueToday) {
        dueLabel = `<span class="due-tag today">due today</span>`;
      } else {
        dueLabel = `<span class="due-tag">due ${todo.dueDate}</span>`;
      }
    }

    li.className = "todo-item" + (todo.done ? " done" : "") + (isOverdue ? " is-overdue" : "");
    // Done tasks don't get an edit button (they're locked once completed).
    const editBtn = todo.done ? "" : `<button class="edit" title="Edit">✎</button>`;
    // Optional link icon next to the title (clickable, opens in new tab).
    const linkBtn = todo.link
      ? `<a class="task-link" target="_blank" rel="noopener noreferrer" title="Open link">↗</a>`
      : "";
    // Optional description block below the title row.
    const descBlock = (todo.description && todo.description.trim())
      ? `<p class="task-desc"></p>`
      : "";
    li.innerHTML = `
      <div class="todo-head">
        <input type="checkbox" ${todo.done ? "checked" : ""} />
        <span class="text"></span>
        ${linkBtn}
        ${dueLabel}
        <span class="xp-tag ${todo.difficulty}">${todo.xp} XP</span>
        ${editBtn}
        <button class="delete" title="Delete">×</button>
      </div>
      ${descBlock}
    `;
    li.querySelector(".text").textContent = todo.text;
    if (todo.link) li.querySelector(".task-link").href = todo.link;
    if (descBlock) li.querySelector(".task-desc").textContent = todo.description;
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) completeTask(todo);
      else uncompleteTask(todo);
    });
    const editEl = li.querySelector(".edit");
    if (editEl) editEl.addEventListener("click", () => startEdit(todo.id));
    li.querySelector(".delete").addEventListener("click", () => deleteTodo(todo.id));
    targetList.appendChild(li);
  });

  document.getElementById("emptyMsg").classList.toggle("hidden", allActive.length > 0);
  document.getElementById("doneEmptyMsg").classList.toggle("hidden", allDone.length > 0);
  document.getElementById("doneCount").textContent = `(${allDone.length})`;

  // Death overlay
  const overlay = document.getElementById("deathOverlay");
  if (!state.pet.alive) {
    overlay.classList.remove("hidden");
    document.getElementById("deathName").textContent = state.pet.name || "your pet";
    document.getElementById("deathStats").textContent =
      `Weekdays survived: ${state.pet.survivedWeekdays}\n` +
      `Final stage: ${STAGES[state.pet.stageIndex].name}\n` +
      `Tasks completed: ${state.pet.tasksDoneEver}`;
  } else {
    overlay.classList.add("hidden");
  }
}

// ----- BISCUIT -----
// A round chocolate-chip biscuit with a cute little face. We use one
// full-colour SVG and apply a CSS grayscale filter that fades out as
// Penny earns XP toward her next evolution.
const BISCUIT_SVG = `
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="crumbs" cx="40%" cy="35%">
        <stop offset="0%" stop-color="#f8d490"/>
        <stop offset="100%" stop-color="#b8853d"/>
      </radialGradient>
    </defs>
    <!-- biscuit body -->
    <circle cx="50" cy="50" r="42" fill="url(#crumbs)" stroke="#8a5a1f" stroke-width="2.5"/>
    <!-- chocolate chip "eyes" + a few decorative chips -->
    <ellipse cx="36" cy="42" rx="5" ry="4.5" fill="#4a2412"/>
    <ellipse cx="64" cy="42" rx="5" ry="4.5" fill="#4a2412"/>
    <!-- eye shine -->
    <circle cx="34.5" cy="40.5" r="1.2" fill="#ffffff" opacity="0.9"/>
    <circle cx="62.5" cy="40.5" r="1.2" fill="#ffffff" opacity="0.9"/>
    <!-- happy mouth -->
    <path d="M 38,62 Q 50,72 62,62" stroke="#4a2412" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <!-- pink blush -->
    <ellipse cx="26" cy="58" rx="5" ry="3" fill="#ff8fb8" opacity="0.65"/>
    <ellipse cx="74" cy="58" rx="5" ry="3" fill="#ff8fb8" opacity="0.65"/>
    <!-- extra chocolate chips -->
    <ellipse cx="22" cy="32" rx="3" ry="2.5" fill="#4a2412"/>
    <ellipse cx="78" cy="30" rx="3" ry="2.5" fill="#4a2412"/>
    <ellipse cx="50" cy="26" rx="3" ry="2.2" fill="#4a2412"/>
    <ellipse cx="28" cy="76" rx="3" ry="2" fill="#4a2412"/>
    <ellipse cx="72" cy="76" rx="3" ry="2" fill="#4a2412"/>
    <!-- neon sprinkles -->
    <rect x="46" y="50" width="6" height="2" rx="1" fill="#ff4fbf" transform="rotate(25 49 51)"/>
    <rect x="18" y="48" width="5" height="2" rx="1" fill="#2ee6c8" transform="rotate(-30 20 49)"/>
    <rect x="77" y="50" width="5" height="2" rx="1" fill="#b14bff" transform="rotate(35 79 51)"/>
    <rect x="38" y="32" width="5" height="2" rx="1" fill="#ffd84a" transform="rotate(-15 40 33)"/>
    <rect x="58" y="78" width="5" height="2" rx="1" fill="#2ee6c8" transform="rotate(45 60 79)"/>
  </svg>`;

function renderBiscuit() {
  const el = document.getElementById("biscuit");
  const caption = document.getElementById("biscuitCaption");
  el.innerHTML = BISCUIT_SVG;

  // Where are we in the journey to the next evolution?
  const stageIdx = state.pet.stageIndex;
  const isFinal = stageIdx >= STAGES.length - 1;

  if (isFinal) {
    el.style.filter = "grayscale(0%)";
    caption.textContent = "Final form reached!";
    return;
  }
  const next = STAGES[stageIdx + 1];
  const base = state.pet.xpAtLastEvolution || 0;
  const needed = next.xpNeeded - base;
  const earned = Math.max(0, state.pet.xp - base);
  const progress = needed > 0 ? Math.min(1, earned / needed) : 1;
  // grayscale 100% (no XP) → 0% (full biscuit)
  const gray = Math.round((1 - progress) * 100);
  el.style.filter = `grayscale(${gray}%)`;
  caption.textContent = `${Math.floor(earned)} / ${needed} XP to ${next.name}`;
}

function setBar(id, value) {
  const el = document.getElementById(id);
  el.style.width = Math.max(0, Math.min(100, value)) + "%";
  if (value > 60) el.style.background = "var(--good)";
  else if (value > 30) el.style.background = "var(--okay)";
  else el.style.background = "var(--bad)";
}

// Show "73 / 100" next to the bar label, and put a friendly explanation
// into the stat's title attribute (browser-native hover bubble).
function updateStatLabel(statId, valueId, value, tooltipText) {
  const rounded = Math.round(value);
  document.getElementById(valueId).textContent = `${rounded} / 100`;
  document.getElementById(statId).title = tooltipText;
}

function buildHungerTooltip() {
  const h = Math.round(state.pet.hunger);
  const lacking = 100 - h;
  const weekend = isWeekend(new Date());
  let status;
  if (h >= 90)      status = `She's full and happy.`;
  else if (h >= 60) status = `She's doing fine.`;
  else if (h >= 30) status = `She's getting peckish.`;
  else if (h > 0)   status = `She's hungry!`;
  else              status = `She's starving!`;
  const rule = weekend
    ? `Weekend — hunger doesn't decay until Monday.`
    : `Drops about 50 points per weekday.`;
  return `Hunger: ${h} / 100 (lacking ${lacking}).\n${status}\n${rule}\nEach task you tick off feeds her +20 hunger.`;
}

function buildHappinessTooltip() {
  const hp = Math.round(state.pet.happiness);
  const lacking = 100 - hp;
  const weekend = isWeekend(new Date());
  let status;
  if (hp >= 90)      status = `She's beaming.`;
  else if (hp >= 60) status = `She's content.`;
  else if (hp >= 30) status = `She's a bit glum.`;
  else if (hp > 0)   status = `She's miserable!`;
  else               status = `She's heartbroken!`;
  const hungryNote = state.pet.hunger < HUNGRY_THRESHOLD
    ? ` Happiness drops 50% faster right now because she's hungry.`
    : ``;
  const rule = weekend
    ? `Weekend — happiness doesn't decay until Monday.`
    : `Drops about 50 points per weekday.${hungryNote}`;
  return `Happiness: ${hp} / 100 (lacking ${lacking}).\n${status}\n${rule}\nEach task you tick off cheers her up +15.`;
}

// ============================================================
// 9) WIRE UP — connect buttons + inputs to the functions above.
// ============================================================

// ----- ADD-TASK FORM: expand / collapse / read / clear -----
function openAddTask() {
  document.getElementById("addTaskPanel").classList.remove("hidden");
  document.getElementById("openAddTaskBtn").classList.add("hidden");
  setTimeout(() => document.getElementById("taskInput").focus(), 0);
}
function closeAddTask() {
  document.getElementById("addTaskPanel").classList.add("hidden");
  document.getElementById("openAddTaskBtn").classList.remove("hidden");
}
function readAddForm() {
  return {
    text: document.getElementById("taskInput").value,
    due: document.getElementById("dueInput").value || null,
    description: document.getElementById("descInput").value,
    link: document.getElementById("linkInput").value,
  };
}
function clearAddForm() {
  document.getElementById("taskInput").value = "";
  document.getElementById("dueInput").value = "";
  document.getElementById("descInput").value = "";
  document.getElementById("linkInput").value = "";
}

document.getElementById("openAddTaskBtn").addEventListener("click", openAddTask);
document.getElementById("cancelAddBtn").addEventListener("click", () => {
  clearAddForm();
  closeAddTask();
});

document.querySelectorAll(".diff-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const f = readAddForm();
    if (!f.text.trim()) return; // need a title
    const xp = parseInt(btn.dataset.xp, 10);
    const difficulty = btn.classList.contains("hard") ? "hard"
                     : btn.classList.contains("medium") ? "medium" : "normal";
    addTodo(f.text, xp, difficulty, f.due, f.description, f.link);
    clearAddForm();
    closeAddTask();
  });
});

document.getElementById("clearDue").addEventListener("click", () => {
  document.getElementById("dueInput").value = "";
});

// Pressing Enter in the title input = add as Medium (a sensible default).
// (Enter in the description textarea makes a newline as expected.)
document.getElementById("taskInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const f = readAddForm();
    if (!f.text.trim()) return;
    addTodo(f.text, 10, "medium", f.due, f.description, f.link);
    clearAddForm();
    closeAddTask();
  }
});

document.getElementById("renamePetAction").addEventListener("click", () => {
  closeSettings();
  promptForName();
});

// ----- PET INTERACTIVITY -----
// Single click → cute jiggle. Double click → shower of hearts and kisses.
const petStageEl = document.getElementById("petStage");
const habitatEl = document.getElementById("habitat");

function jigglePet() {
  if (!state.pet.alive) return;
  // Remove and re-add so the animation restarts cleanly if you spam-click.
  petStageEl.classList.remove("wiggle");
  // Force a reflow so the browser registers the class removal before re-add.
  void petStageEl.offsetWidth;
  petStageEl.classList.add("wiggle");
  setTimeout(() => petStageEl.classList.remove("wiggle"), 600);
}

function showerHearts(count) {
  if (!state.pet.alive) return;
  spawnSymbols(["💖", "💕", "💋", "💗", "✨", "💞"], count);
}

// Bigger, longer-lasting shower for evolution celebrations.
function showerSparkles(count) {
  spawnSymbols(["✨", "🌟", "⭐", "💫", "🎉", "💖"], count, true);
}

function spawnSymbols(symbols, count, big) {
  for (let i = 0; i < count; i++) {
    const el = document.createElement("span");
    el.className = "float-heart" + (big ? " big" : "");
    el.textContent = symbols[Math.floor(Math.random() * symbols.length)];
    const offsetX = (Math.random() - 0.5) * (big ? 180 : 120);
    const drift = (Math.random() - 0.5) * 60;
    const rot = (Math.random() - 0.5) * 50;
    el.style.left = `calc(50% + ${offsetX}px)`;
    el.style.setProperty("--drift", `${drift}px`);
    el.style.setProperty("--rot", `${rot}deg`);
    el.style.animationDelay = (i * (big ? 50 : 70)) + "ms";
    habitatEl.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }
}

// Cinematic evolution animation: spawn a flying biscuit that Penny chomps,
// then shake the pet, flash the habitat, and rain down sparkles.
function playEvolutionAnimation() {
  // 1) Biscuit flies in from the right and gets eaten
  spawnFlyingBiscuit();

  // 2) Chomp partway through the biscuit's flight
  setTimeout(() => {
    petStageEl.classList.remove("chomp");
    void petStageEl.offsetWidth;
    petStageEl.classList.add("chomp");
    setTimeout(() => petStageEl.classList.remove("chomp"), 350);
  }, 700);

  // 3) After the biscuit is gone, the dramatic hatch pop + flash + sparkles
  setTimeout(() => {
    petStageEl.classList.remove("evolving");
    void petStageEl.offsetWidth;
    petStageEl.classList.add("evolving");
    setTimeout(() => petStageEl.classList.remove("evolving"), 1400);

    habitatEl.classList.remove("flash");
    void habitatEl.offsetWidth;
    habitatEl.classList.add("flash");
    setTimeout(() => habitatEl.classList.remove("flash"), 900);

    showerSparkles(16);
  }, 1100);
}

// Spawn a small biscuit element that flies from the right edge of the
// habitat toward Penny's mouth, then shrinks and fades as she chomps it.
function spawnFlyingBiscuit() {
  const biscuit = document.createElement("div");
  biscuit.className = "eating-biscuit";
  biscuit.innerHTML = BISCUIT_SVG;
  habitatEl.appendChild(biscuit);
  biscuit.addEventListener("animationend", () => biscuit.remove());
}

// ----- AMBIENT STARS at the edges of the habitat -----
// Few and subtle since the artwork itself has a beautiful starfield;
// these add a touch of twinkling motion in the dark space around it.
function setupAmbientStars() {
  const symbols = ["✦", "✧", "⋆", "✶"];
  const slots = [
    { top: 8,  left: 8  }, { top: 8,  left: 88 },
    { top: 50, left: 4  }, { top: 50, left: 92 },
    { top: 88, left: 12 }, { top: 88, left: 84 },
  ];
  slots.forEach((slot, i) => {
    const star = document.createElement("span");
    star.className = "ambient-star";
    star.textContent = symbols[i % symbols.length];
    star.style.top = slot.top + "%";
    star.style.left = slot.left + "%";
    star.style.fontSize = (9 + Math.random() * 5) + "px";
    star.style.animationDelay = (Math.random() * 4) + "s";
    star.style.animationDuration = (2.5 + Math.random() * 2.5) + "s";
    habitatEl.appendChild(star);
  });
}
setupAmbientStars();

// ----- DONE PANEL TOGGLE -----
document.getElementById("doneToggle").addEventListener("click", () => {
  const panel = document.getElementById("donePanel");
  const toggle = document.getElementById("doneToggle");
  const isClosed = panel.classList.toggle("hidden");
  toggle.setAttribute("aria-expanded", isClosed ? "false" : "true");
  toggle.classList.toggle("open", !isClosed);
});

// ----- PAGINATION BUTTON WIRING -----
document.getElementById("activePrev").addEventListener("click", () => { activePage = Math.max(0, activePage - 1); render(); });
document.getElementById("activeNext").addEventListener("click", () => { activePage = activePage + 1; render(); });
document.getElementById("donePrev").addEventListener("click",   () => { donePage   = Math.max(0, donePage   - 1); render(); });
document.getElementById("doneNext").addEventListener("click",   () => { donePage   = donePage   + 1; render(); });

petStageEl.addEventListener("click", jigglePet);
petStageEl.addEventListener("dblclick", () => {
  jigglePet();             // extra-big jiggle for double-click too
  showerHearts(7);
});
document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("closeSettingsBtn").addEventListener("click", closeSettings);
document.getElementById("resetPetAction").addEventListener("click", resetPetOnly);
document.getElementById("resetXpAction").addEventListener("click", resetXp);
document.getElementById("resetTasksAction").addEventListener("click", resetTasks);
// Click outside the settings card to close.
document.getElementById("settingsOverlay").addEventListener("click", (e) => {
  if (e.target.id === "settingsOverlay") closeSettings();
});
document.getElementById("reviveBtn").addEventListener("click", reviveAsEgg);

// ============================================================
// 10) STARTUP — the very first thing that happens.
// ============================================================

// If the pet has no name yet, prompt for one.
if (!state.pet.name) {
  promptForName();
}

// `isTickRender` distinguishes the background 1-second tick from a real
// user action. While editing, the tick render skips rebuilding the todos
// list so the date picker doesn't get torn down underneath the user.
let isTickRender = false;

// Apply any time that passed while the page was closed.
applyTimePassage();
saveState();
render();

// Keep the game ticking while the page is open.
// IMPORTANT: while a task is being edited we still let time pass and save
// state, but we DO NOT touch the DOM at all. Any DOM mutation
// (even on a separate element) can cause the open native date picker to
// close.
setInterval(() => {
  applyTimePassage();
  saveState();
  if (editingId) return;
  isTickRender = true;
  render();
  isTickRender = false;
}, TICK_MS);
