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

function addTodo(text, xp, difficulty, dueDate) {
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
  });
  saveState();
  render();
}

function deleteTodo(id) {
  state.todos = state.todos.filter(t => t.id !== id);
  saveState();
  render();
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

// A small helper to build a stage's SVG string.
// Using bright neon colors so they pop on the dark background.
const SVGS = {
  // STAGE 0: Egg
  0: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="50" cy="55" rx="28" ry="36" fill="#f3e9d2" stroke="#b14bff" stroke-width="2"/>
      <circle cx="40" cy="45" r="3" fill="#b14bff"/>
      <circle cx="60" cy="60" r="2.5" fill="#ff4fbf"/>
      <circle cx="52" cy="35" r="2" fill="#2ee6c8"/>
      <ellipse cx="35" cy="70" rx="3" ry="2" fill="#b14bff" opacity="0.6"/>
    </svg>`,

  // STAGE 1: Blob
  1: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <path d="M20,70 Q15,40 50,30 Q85,40 80,70 Q80,85 50,85 Q20,85 20,70 Z"
            fill="#b14bff" stroke="#ff4fbf" stroke-width="2"/>
      <circle cx="40" cy="55" r="5" fill="white"/>
      <circle cx="60" cy="55" r="5" fill="white"/>
      <circle cx="40" cy="56" r="2.5" fill="#15101e"/>
      <circle cx="60" cy="56" r="2.5" fill="#15101e"/>
      <path d="M44,70 Q50,74 56,70" stroke="#15101e" stroke-width="2" fill="none" stroke-linecap="round"/>
    </svg>`,

  // STAGE 2: 1-headed puppy
  2: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <!-- body -->
      <ellipse cx="50" cy="72" rx="24" ry="14" fill="#7a3eb8"/>
      <!-- legs -->
      <rect x="33" y="78" width="6" height="12" rx="2" fill="#7a3eb8"/>
      <rect x="61" y="78" width="6" height="12" rx="2" fill="#7a3eb8"/>
      <!-- head -->
      <circle cx="50" cy="42" r="20" fill="#9655d6"/>
      <!-- ears -->
      <ellipse cx="35" cy="32" rx="6" ry="10" fill="#5e2e91" transform="rotate(-20 35 32)"/>
      <ellipse cx="65" cy="32" rx="6" ry="10" fill="#5e2e91" transform="rotate(20 65 32)"/>
      <!-- eyes -->
      <circle cx="43" cy="42" r="3" fill="white"/>
      <circle cx="57" cy="42" r="3" fill="white"/>
      <circle cx="43" cy="43" r="1.5" fill="#15101e"/>
      <circle cx="57" cy="43" r="1.5" fill="#15101e"/>
      <!-- nose -->
      <ellipse cx="50" cy="50" rx="3" ry="2" fill="#ff4fbf"/>
      <!-- mouth -->
      <path d="M47,54 Q50,56 53,54" stroke="#15101e" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    </svg>`,

  // STAGE 3: 2-headed puppy
  3: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="50" cy="74" rx="28" ry="14" fill="#7a3eb8"/>
      <rect x="30" y="80" width="6" height="12" rx="2" fill="#7a3eb8"/>
      <rect x="64" y="80" width="6" height="12" rx="2" fill="#7a3eb8"/>
      <!-- left head -->
      <circle cx="35" cy="46" r="16" fill="#9655d6"/>
      <ellipse cx="24" cy="36" rx="5" ry="8" fill="#5e2e91" transform="rotate(-20 24 36)"/>
      <circle cx="30" cy="46" r="2.5" fill="white"/><circle cx="30" cy="47" r="1.2" fill="#15101e"/>
      <circle cx="40" cy="46" r="2.5" fill="white"/><circle cx="40" cy="47" r="1.2" fill="#15101e"/>
      <ellipse cx="35" cy="53" rx="2.5" ry="1.6" fill="#ff4fbf"/>
      <!-- right head -->
      <circle cx="65" cy="46" r="16" fill="#9655d6"/>
      <ellipse cx="76" cy="36" rx="5" ry="8" fill="#5e2e91" transform="rotate(20 76 36)"/>
      <circle cx="60" cy="46" r="2.5" fill="white"/><circle cx="60" cy="47" r="1.2" fill="#15101e"/>
      <circle cx="70" cy="46" r="2.5" fill="white"/><circle cx="70" cy="47" r="1.2" fill="#15101e"/>
      <ellipse cx="65" cy="53" rx="2.5" ry="1.6" fill="#ff4fbf"/>
    </svg>`,

  // STAGE 4: 3-headed puppy
  4: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="50" cy="78" rx="32" ry="14" fill="#7a3eb8"/>
      <rect x="28" y="84" width="6" height="12" rx="2" fill="#7a3eb8"/>
      <rect x="66" y="84" width="6" height="12" rx="2" fill="#7a3eb8"/>
      <!-- left head -->
      <circle cx="26" cy="52" r="14" fill="#9655d6"/>
      <ellipse cx="17" cy="44" rx="4" ry="7" fill="#5e2e91" transform="rotate(-25 17 44)"/>
      <circle cx="22" cy="52" r="2" fill="white"/><circle cx="22" cy="53" r="1" fill="#15101e"/>
      <circle cx="30" cy="52" r="2" fill="white"/><circle cx="30" cy="53" r="1" fill="#15101e"/>
      <ellipse cx="26" cy="58" rx="2" ry="1.4" fill="#ff4fbf"/>
      <!-- middle head -->
      <circle cx="50" cy="42" r="16" fill="#a463e5"/>
      <ellipse cx="40" cy="32" rx="5" ry="8" fill="#5e2e91" transform="rotate(-20 40 32)"/>
      <ellipse cx="60" cy="32" rx="5" ry="8" fill="#5e2e91" transform="rotate(20 60 32)"/>
      <circle cx="44" cy="42" r="2.5" fill="white"/><circle cx="44" cy="43" r="1.2" fill="#15101e"/>
      <circle cx="56" cy="42" r="2.5" fill="white"/><circle cx="56" cy="43" r="1.2" fill="#15101e"/>
      <ellipse cx="50" cy="49" rx="2.5" ry="1.6" fill="#ff4fbf"/>
      <!-- right head -->
      <circle cx="74" cy="52" r="14" fill="#9655d6"/>
      <ellipse cx="83" cy="44" rx="4" ry="7" fill="#5e2e91" transform="rotate(25 83 44)"/>
      <circle cx="70" cy="52" r="2" fill="white"/><circle cx="70" cy="53" r="1" fill="#15101e"/>
      <circle cx="78" cy="52" r="2" fill="white"/><circle cx="78" cy="53" r="1" fill="#15101e"/>
      <ellipse cx="74" cy="58" rx="2" ry="1.4" fill="#ff4fbf"/>
    </svg>`,

  // STAGE 5: Big 3-headed Cerberus (final form)
  5: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <!-- shadow / glow -->
      <ellipse cx="50" cy="90" rx="36" ry="4" fill="#ff4fbf" opacity="0.25"/>
      <!-- body -->
      <ellipse cx="50" cy="72" rx="36" ry="18" fill="#5e2e91"/>
      <!-- legs -->
      <rect x="22" y="80" width="8" height="16" rx="2" fill="#5e2e91"/>
      <rect x="70" y="80" width="8" height="16" rx="2" fill="#5e2e91"/>
      <!-- tail -->
      <path d="M82,70 Q92,60 90,50" stroke="#5e2e91" stroke-width="5" fill="none" stroke-linecap="round"/>
      <!-- left head -->
      <circle cx="22" cy="46" r="16" fill="#7a3eb8"/>
      <ellipse cx="12" cy="36" rx="5" ry="9" fill="#3d1d61" transform="rotate(-25 12 36)"/>
      <circle cx="18" cy="46" r="3" fill="#ff4fbf"/><circle cx="18" cy="46" r="1.4" fill="#15101e"/>
      <circle cx="26" cy="46" r="3" fill="#ff4fbf"/><circle cx="26" cy="46" r="1.4" fill="#15101e"/>
      <path d="M16,54 L20,57 L24,54 L28,57" stroke="#15101e" stroke-width="1.5" fill="none"/>
      <!-- middle head (bigger) -->
      <circle cx="50" cy="34" r="20" fill="#9655d6"/>
      <ellipse cx="38" cy="22" rx="6" ry="10" fill="#3d1d61" transform="rotate(-20 38 22)"/>
      <ellipse cx="62" cy="22" rx="6" ry="10" fill="#3d1d61" transform="rotate(20 62 22)"/>
      <circle cx="43" cy="34" r="3.5" fill="#2ee6c8"/><circle cx="43" cy="34" r="1.6" fill="#15101e"/>
      <circle cx="57" cy="34" r="3.5" fill="#2ee6c8"/><circle cx="57" cy="34" r="1.6" fill="#15101e"/>
      <ellipse cx="50" cy="44" rx="3" ry="2" fill="#ff4fbf"/>
      <path d="M42,50 L46,54 L50,50 L54,54 L58,50" stroke="#15101e" stroke-width="2" fill="none"/>
      <!-- right head -->
      <circle cx="78" cy="46" r="16" fill="#7a3eb8"/>
      <ellipse cx="88" cy="36" rx="5" ry="9" fill="#3d1d61" transform="rotate(25 88 36)"/>
      <circle cx="74" cy="46" r="3" fill="#ff4fbf"/><circle cx="74" cy="46" r="1.4" fill="#15101e"/>
      <circle cx="82" cy="46" r="3" fill="#ff4fbf"/><circle cx="82" cy="46" r="1.4" fill="#15101e"/>
      <path d="M72,54 L76,57 L80,54 L84,57" stroke="#15101e" stroke-width="1.5" fill="none"/>
    </svg>`,
};

// ============================================================
// 8) RENDER — paint the screen from the current state.
//    Called whenever something changes.
// ============================================================

function render() {
  // Pet name
  document.getElementById("petName").textContent = state.pet.name || "Your Pet";

  // Pet SVG (or gravestone if dead)
  const petStage = document.getElementById("petStage");
  if (!state.pet.alive) {
    petStage.innerHTML = `<div style="font-size:120px">🪦</div>`;
  } else {
    petStage.innerHTML = SVGS[state.pet.stageIndex] || SVGS[0];
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

  // Stat bars
  setBar("hungerFill", state.pet.hunger);
  setBar("happinessFill", state.pet.happiness);

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
  const activeTodos = state.todos.filter(t => !t.done);
  const doneTodos   = state.todos.filter(t => t.done);
  // Render active todos in the main list; done todos in the side list.
  activeTodos.concat(doneTodos).forEach(todo => {
    // Which list does this row belong in?
    const targetList = todo.done ? doneList : list;
    const li = document.createElement("li");

    // EDIT MODE — show input + due date + difficulty picker + save/cancel.
    if (todo.id === editingId && !todo.done) {
      li.className = "todo-item editing";
      li.innerHTML = `
        <input type="text" class="edit-input" maxlength="120" />
        <input type="date" class="edit-due" />
        <div class="edit-diff-row">
          <button class="diff-mini normal" data-xp="5" data-diff="normal">5</button>
          <button class="diff-mini medium" data-xp="10" data-diff="medium">10</button>
          <button class="diff-mini hard" data-xp="20" data-diff="hard">20</button>
        </div>
        <button class="save-edit" title="Save">✓</button>
        <button class="cancel-edit" title="Cancel">×</button>
      `;
      const textInput = li.querySelector(".edit-input");
      const dueInput = li.querySelector(".edit-due");
      textInput.value = editingDraft.text;
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
    li.innerHTML = `
      <input type="checkbox" ${todo.done ? "checked" : ""} />
      <span class="text"></span>
      ${dueLabel}
      <span class="xp-tag ${todo.difficulty}">${todo.xp} XP</span>
      ${editBtn}
      <button class="delete" title="Delete">×</button>
    `;
    li.querySelector(".text").textContent = todo.text;
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) completeTask(todo);
      else uncompleteTask(todo);
    });
    const editEl = li.querySelector(".edit");
    if (editEl) editEl.addEventListener("click", () => startEdit(todo.id));
    li.querySelector(".delete").addEventListener("click", () => deleteTodo(todo.id));
    targetList.appendChild(li);
  });

  document.getElementById("emptyMsg").classList.toggle("hidden", activeTodos.length > 0);
  document.getElementById("doneEmptyMsg").classList.toggle("hidden", doneTodos.length > 0);

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
// A round chocolate-chip biscuit. We use one full-colour SVG and apply
// a CSS grayscale filter that fades out as Penny earns XP toward her
// next evolution. At 0% progress: black-and-white. At 100%: full colour.
const BISCUIT_SVG = `
  <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <!-- biscuit body -->
    <circle cx="50" cy="50" r="42" fill="#d6a55a" stroke="#8a5a1f" stroke-width="2"/>
    <circle cx="50" cy="50" r="42" fill="url(#crumbs)" opacity="0.5"/>
    <defs>
      <radialGradient id="crumbs">
        <stop offset="0%" stop-color="#f0c47a"/>
        <stop offset="100%" stop-color="#b8853d"/>
      </radialGradient>
    </defs>
    <!-- chocolate chips -->
    <ellipse cx="32" cy="35" rx="6" ry="5" fill="#4a2412"/>
    <ellipse cx="62" cy="30" rx="5" ry="4" fill="#4a2412"/>
    <ellipse cx="70" cy="58" rx="6" ry="5" fill="#4a2412"/>
    <ellipse cx="40" cy="62" rx="5" ry="4" fill="#4a2412"/>
    <ellipse cx="50" cy="48" rx="4" ry="3" fill="#4a2412"/>
    <ellipse cx="28" cy="68" rx="4" ry="3" fill="#4a2412"/>
    <!-- neon sprinkles -->
    <rect x="55" y="42" width="6" height="2" rx="1" fill="#ff4fbf" transform="rotate(20 58 43)"/>
    <rect x="20" y="50" width="6" height="2" rx="1" fill="#2ee6c8" transform="rotate(-30 23 51)"/>
    <rect x="65" y="70" width="6" height="2" rx="1" fill="#b14bff" transform="rotate(45 68 71)"/>
    <rect x="38" y="26" width="6" height="2" rx="1" fill="#ffd84a" transform="rotate(-15 41 27)"/>
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

// ============================================================
// 9) WIRE UP — connect buttons + inputs to the functions above.
// ============================================================

document.querySelectorAll(".diff-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const input = document.getElementById("taskInput");
    const due = document.getElementById("dueInput").value || null;
    const xp = parseInt(btn.dataset.xp, 10);
    const difficulty = btn.classList.contains("hard") ? "hard"
                     : btn.classList.contains("medium") ? "medium" : "normal";
    addTodo(input.value, xp, difficulty, due);
    input.value = "";
    document.getElementById("dueInput").value = "";
    input.focus();
  });
});

document.getElementById("clearDue").addEventListener("click", () => {
  document.getElementById("dueInput").value = "";
});

// Pressing Enter in the input = add as Medium (a sensible default)
document.getElementById("taskInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const due = document.getElementById("dueInput").value || null;
    addTodo(e.target.value, 10, "medium", due);
    e.target.value = "";
    document.getElementById("dueInput").value = "";
  }
});

document.getElementById("renameBtn").addEventListener("click", promptForName);
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
setInterval(() => {
  isTickRender = true;
  applyTimePassage();
  saveState();
  render();
  isTickRender = false;
}, TICK_MS);
