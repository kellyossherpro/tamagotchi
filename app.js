/*
  app.js — the BRAIN of the game.
  This file is the rules and behavior. It:
    - loads and saves your pet and todos in your browser
    - draws the right pet on screen
    - handles adding/checking/deleting tasks
    - feeds + heals the pet when you finish tasks
    - drains hunger over time (weekdays only)
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
    // Pets that have completed the whole journey to Big Cerberus.
    // Each entry is a snapshot: { name, finishedAt }
    graduated: [],
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

  // Check death — hunger hits 0
  if (state.pet.alive && state.pet.hunger <= 0) {
    state.pet.alive = false;
  }

  // Apply overdue penalties for any unfinished tasks past their due date.
  applyOverdueLosses();

  // Check evolution (level up if BOTH thresholds met).
  // When evolution fires, Penny "eats the biscuit": big feed bonus, and we
  // record the new XP baseline so the biscuit resets to greyscale.
  while (state.pet.stageIndex < STAGES.length - 1) {
    const next = STAGES[state.pet.stageIndex + 1];
    if (state.pet.survivedWeekdays >= next.daysNeeded && state.pet.xp >= next.xpNeeded) {
      state.pet.stageIndex += 1;
      state.pet.hunger = Math.min(100, state.pet.hunger + BISCUIT_FEED_HUNGER);
      state.pet.xpAtLastEvolution = next.xpNeeded;
      // If this pet just reached the final Cerberus form, schedule the
      // graduation ceremony — she gets moved into the collection and a
      // fresh egg spawns beside her.
      if (state.pet.stageIndex === STAGES.length - 1) {
        scheduleGraduation();
      }
    } else {
      break;
    }
  }
}

// When a pet first hits Big Cerberus, wait for the evolution animation
// to finish, then move her into the "graduated" collection and spawn a
// brand-new egg. All existing tasks are re-armed so they can feed the
// new pet just like they fed the first one.
let graduationScheduled = false;
function scheduleGraduation() {
  if (graduationScheduled) return;
  graduationScheduled = true;
  setTimeout(() => {
    // Snapshot the graduating pet into the collection
    state.graduated = state.graduated || [];
    state.graduated.push({
      name: state.pet.name,
      finishedAt: Date.now(),
    });
    // Ask for a new name for the fresh egg (default suggests numbered
    // sibling to keep the family vibe)
    const suggestion = state.pet.name + " II";
    const newName = prompt(
      `${state.pet.name} has become a full Cerberus and joined your pack! Name your new egg:`,
      suggestion
    ) || suggestion;
    // Reset the active pet to a fresh egg. Todos stay exactly as they are:
    // completed tasks remain completed (they're historical achievements,
    // not repeatable), and active tasks remain active to feed the new pet.
    state.pet = freshState().pet;
    state.pet.name = newName.trim().slice(0, 24);
    state.tasksCompletedToday = 0;
    saveState();
    render();
    graduationScheduled = false;
  }, 3200); // ~3s: hatchPop finishes ~1.4s, plus a beat for the sparkle shower
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
    "XP, days survived, hunger all reset to the start.\n" +
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
    "Days survived, hunger STAY where they are.\n" +
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

  // STAGE 1: Blob — galaxy edition (cosmic purple → magenta with inner stars + blush)
  1: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="blobGalaxy" cx="38%" cy="32%" r="78%">
          <stop offset="0%" stop-color="#ff8fd6"/>
          <stop offset="35%" stop-color="#b14bff"/>
          <stop offset="75%" stop-color="#5a2bb0"/>
          <stop offset="100%" stop-color="#1e1a55"/>
        </radialGradient>
      </defs>
      <!-- wobbly blob body with extra bumps -->
      <path d="M 50,16
               C 76,14 92,32 88,52
               C 96,68 80,86 60,84
               C 44,92 18,84 16,64
               C 6,48 18,24 36,22
               C 40,18 46,16 50,16 Z"
            fill="url(#blobGalaxy)"
            stroke="#ff4fbf" stroke-width="2"
            filter="drop-shadow(0 0 6px rgba(177,75,255,.45))"/>
      <!-- inner stars / cosmic sparkles -->
      <circle cx="28" cy="40" r="1.4" fill="#ffffff" opacity="0.95"/>
      <circle cx="68" cy="32" r="1" fill="#ffffff" opacity="0.85"/>
      <circle cx="72" cy="62" r="1.5" fill="#ffd84a" opacity="0.9"/>
      <circle cx="22" cy="62" r="1" fill="#2ee6c8" opacity="0.9"/>
      <circle cx="55" cy="78" r="1.2" fill="#ffffff" opacity="0.8"/>
      <circle cx="40" cy="28" r="0.8" fill="#2ee6c8" opacity="0.9"/>
      <circle cx="80" cy="46" r="0.9" fill="#ffffff" opacity="0.8"/>
      <!-- big cute eyes -->
      <circle cx="38" cy="50" r="7" fill="#ffffff"/>
      <circle cx="62" cy="50" r="7" fill="#ffffff"/>
      <circle cx="38" cy="52" r="3.4" fill="#15101e"/>
      <circle cx="62" cy="52" r="3.4" fill="#15101e"/>
      <!-- twinkle reflections -->
      <circle cx="36" cy="50" r="1.3" fill="#ffffff"/>
      <circle cx="60" cy="50" r="1.3" fill="#ffffff"/>
      <!-- blush -->
      <ellipse cx="26" cy="60" rx="4" ry="2" fill="#ff4fbf" opacity="0.55"/>
      <ellipse cx="74" cy="60" rx="4" ry="2" fill="#ff4fbf" opacity="0.55"/>
      <!-- happy mouth -->
      <path d="M 42,66 Q 50,73 58,66" stroke="#15101e" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    </svg>`,

  // STAGE 2: 1-headed pup — kawaii galaxy chibi (pink/purple body, big sparkly eyes)
  2: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="pup1Body" cx="40%" cy="30%" r="80%">
          <stop offset="0%" stop-color="#ffc0e5"/>
          <stop offset="55%" stop-color="#b14bff"/>
          <stop offset="100%" stop-color="#3d1d61"/>
        </radialGradient>
        <radialGradient id="pup1Head" cx="40%" cy="25%" r="85%">
          <stop offset="0%" stop-color="#ffd6f0"/>
          <stop offset="55%" stop-color="#c87aff"/>
          <stop offset="100%" stop-color="#4a1d8a"/>
        </radialGradient>
      </defs>
      <!-- floating heart above -->
      <path d="M 50,7 q -1.5,-2.5 -4,0 q 0,2.5 4,5 q 4,-2.5 4,-5 q -2.5,-2.5 -4,0" fill="#ff4fbf"/>
      <!-- sparkles -->
      <circle cx="18" cy="40" r="0.9" fill="#ffffff" opacity="0.9"/>
      <circle cx="82" cy="42" r="0.9" fill="#ffd84a" opacity="0.9"/>
      <circle cx="20" cy="68" r="0.7" fill="#2ee6c8" opacity="0.9"/>
      <circle cx="80" cy="70" r="0.7" fill="#ffffff" opacity="0.9"/>
      <!-- body -->
      <ellipse cx="50" cy="72" rx="26" ry="14" fill="url(#pup1Body)"/>
      <ellipse cx="50" cy="76" rx="14" ry="8" fill="#fff3df" opacity="0.95"/>
      <!-- paw pads -->
      <ellipse cx="34" cy="84" rx="5" ry="3" fill="#fff3df"/>
      <ellipse cx="66" cy="84" rx="5" ry="3" fill="#fff3df"/>
      <circle cx="34" cy="85" r="1.6" fill="#ff8fb8"/>
      <circle cx="66" cy="85" r="1.6" fill="#ff8fb8"/>
      <!-- fluffy white collar -->
      <path d="M 30,62 Q 34,66 38,63 Q 42,67 46,63 Q 50,67 54,63 Q 58,67 62,63 Q 66,66 70,62 Q 64,73 50,74 Q 36,73 30,62 Z" fill="white"/>
      <!-- head -->
      <circle cx="50" cy="38" r="22" fill="url(#pup1Head)"/>
      <!-- pointy ears -->
      <path d="M 32,27 L 26,7 L 42,21 Z" fill="#9655d6"/>
      <path d="M 35,21 L 32,11 L 40,20 Z" fill="#ff8fb8"/>
      <path d="M 68,27 L 74,7 L 58,21 Z" fill="#9655d6"/>
      <path d="M 65,21 L 68,11 L 60,20 Z" fill="#ff8fb8"/>
      <!-- huge sparkly eyes -->
      <ellipse cx="41" cy="38" rx="5.5" ry="7" fill="#15101e"/>
      <circle cx="39" cy="35" r="2" fill="white"/>
      <circle cx="43" cy="42" r="1" fill="white"/>
      <ellipse cx="59" cy="38" rx="5.5" ry="7" fill="#15101e"/>
      <circle cx="57" cy="35" r="2" fill="white"/>
      <circle cx="61" cy="42" r="1" fill="white"/>
      <!-- pink nose + smile -->
      <ellipse cx="50" cy="48" rx="2.5" ry="1.8" fill="#ff4fbf"/>
      <path d="M 45,53 Q 50,57 55,53" stroke="#15101e" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <!-- blush -->
      <circle cx="33" cy="46" r="3" fill="#ff8fb8" opacity="0.55"/>
      <circle cx="67" cy="46" r="3" fill="#ff8fb8" opacity="0.55"/>
    </svg>`,

  // STAGE 3: 2-headed pup — left smiles (pink), right winks (blue)
  3: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="pup2Body" cx="40%" cy="30%" r="80%">
          <stop offset="0%" stop-color="#ffc0e5"/>
          <stop offset="55%" stop-color="#b14bff"/>
          <stop offset="100%" stop-color="#3d1d61"/>
        </radialGradient>
        <radialGradient id="pup2HeadPink" cx="40%" cy="25%" r="85%">
          <stop offset="0%" stop-color="#ffd6f0"/>
          <stop offset="55%" stop-color="#c87aff"/>
          <stop offset="100%" stop-color="#4a1d8a"/>
        </radialGradient>
        <radialGradient id="pup2HeadBlue" cx="40%" cy="25%" r="85%">
          <stop offset="0%" stop-color="#c8d8ff"/>
          <stop offset="55%" stop-color="#7a8fff"/>
          <stop offset="100%" stop-color="#2a2f80"/>
        </radialGradient>
      </defs>
      <!-- floating heart + sparkles -->
      <path d="M 50,7 q -1.5,-2.5 -4,0 q 0,2.5 4,5 q 4,-2.5 4,-5 q -2.5,-2.5 -4,0" fill="#ff4fbf"/>
      <circle cx="14" cy="50" r="0.9" fill="#ffffff" opacity="0.9"/>
      <circle cx="86" cy="50" r="0.9" fill="#ffd84a" opacity="0.9"/>
      <circle cx="50" cy="30" r="0.7" fill="#2ee6c8" opacity="0.9"/>
      <!-- body -->
      <ellipse cx="50" cy="76" rx="32" ry="14" fill="url(#pup2Body)"/>
      <ellipse cx="50" cy="80" rx="18" ry="8" fill="#fff3df" opacity="0.95"/>
      <ellipse cx="30" cy="88" rx="5" ry="3" fill="#fff3df"/>
      <ellipse cx="70" cy="88" rx="5" ry="3" fill="#fff3df"/>
      <circle cx="30" cy="89" r="1.6" fill="#ff8fb8"/>
      <circle cx="70" cy="89" r="1.6" fill="#ff8fb8"/>
      <!-- collar -->
      <path d="M 24,66 Q 28,70 33,67 Q 38,71 43,67 Q 48,71 53,67 Q 58,71 63,67 Q 68,71 72,67 Q 76,70 76,66 Q 72,76 50,77 Q 28,76 24,66 Z" fill="white"/>
      <!-- LEFT head — pink, big happy smile -->
      <circle cx="32" cy="42" r="18" fill="url(#pup2HeadPink)"/>
      <path d="M 18,32 L 12,12 L 26,28 Z" fill="#9655d6"/>
      <path d="M 21,26 L 18,15 L 25,25 Z" fill="#ff8fb8"/>
      <path d="M 42,30 L 45,17 L 36,26 Z" fill="#9655d6"/>
      <path d="M 41,26 L 43,20 L 39,25 Z" fill="#ff8fb8"/>
      <ellipse cx="26" cy="42" rx="4" ry="5.5" fill="#15101e"/>
      <circle cx="25" cy="40" r="1.4" fill="white"/>
      <circle cx="27" cy="45" r="0.8" fill="white"/>
      <ellipse cx="38" cy="42" rx="4" ry="5.5" fill="#15101e"/>
      <circle cx="37" cy="40" r="1.4" fill="white"/>
      <circle cx="39" cy="45" r="0.8" fill="white"/>
      <ellipse cx="32" cy="50" rx="2" ry="1.4" fill="#ff4fbf"/>
      <path d="M 27,55 Q 32,59 37,55" stroke="#15101e" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <circle cx="22" cy="48" r="2.5" fill="#ff8fb8" opacity="0.55"/>
      <circle cx="42" cy="48" r="2.5" fill="#ff8fb8" opacity="0.55"/>
      <!-- RIGHT head — blue, winking -->
      <circle cx="68" cy="42" r="18" fill="url(#pup2HeadBlue)"/>
      <path d="M 82,32 L 88,12 L 74,28 Z" fill="#5a5fc0"/>
      <path d="M 79,26 L 82,15 L 75,25 Z" fill="#a8c7ff"/>
      <path d="M 58,30 L 55,17 L 64,26 Z" fill="#5a5fc0"/>
      <path d="M 59,26 L 57,20 L 61,25 Z" fill="#a8c7ff"/>
      <ellipse cx="62" cy="42" rx="4" ry="5.5" fill="#15101e"/>
      <circle cx="61" cy="40" r="1.4" fill="white"/>
      <circle cx="63" cy="45" r="0.8" fill="white"/>
      <path d="M 70,42 Q 75,39 80,43" stroke="#15101e" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <ellipse cx="68" cy="50" rx="2" ry="1.4" fill="#ff4fbf"/>
      <path d="M 63,55 Q 68,59 73,55" stroke="#15101e" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <circle cx="58" cy="48" r="2.5" fill="#ff8fb8" opacity="0.55"/>
      <circle cx="78" cy="48" r="2.5" fill="#ff8fb8" opacity="0.55"/>
    </svg>`,

  // STAGE 4: 3-headed pup — blue winks, middle pink smiles big, right tongue out
  4: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="pup3Body" cx="40%" cy="30%" r="80%">
          <stop offset="0%" stop-color="#ffc0e5"/>
          <stop offset="55%" stop-color="#b14bff"/>
          <stop offset="100%" stop-color="#3d1d61"/>
        </radialGradient>
        <radialGradient id="pup3HeadPink" cx="40%" cy="25%" r="85%">
          <stop offset="0%" stop-color="#ffd6f0"/>
          <stop offset="55%" stop-color="#c87aff"/>
          <stop offset="100%" stop-color="#4a1d8a"/>
        </radialGradient>
        <radialGradient id="pup3HeadBlue" cx="40%" cy="25%" r="85%">
          <stop offset="0%" stop-color="#c8d8ff"/>
          <stop offset="55%" stop-color="#7a8fff"/>
          <stop offset="100%" stop-color="#2a2f80"/>
        </radialGradient>
      </defs>
      <!-- floating hearts -->
      <path d="M 50,5 q -1.5,-2.5 -4,0 q 0,2.5 4,5 q 4,-2.5 4,-5 q -2.5,-2.5 -4,0" fill="#ff4fbf"/>
      <path d="M 14,28 q -1,-2 -3,0 q 0,2 3,3.5 q 3,-1.5 3,-3.5 q -2,-2 -3,0" fill="#ff4fbf" opacity="0.7"/>
      <path d="M 86,28 q -1,-2 -3,0 q 0,2 3,3.5 q 3,-1.5 3,-3.5 q -2,-2 -3,0" fill="#ff4fbf" opacity="0.7"/>
      <!-- body -->
      <ellipse cx="50" cy="80" rx="34" ry="14" fill="url(#pup3Body)"/>
      <ellipse cx="50" cy="84" rx="20" ry="7" fill="#fff3df" opacity="0.95"/>
      <ellipse cx="28" cy="91" rx="5" ry="3" fill="#fff3df"/>
      <ellipse cx="72" cy="91" rx="5" ry="3" fill="#fff3df"/>
      <circle cx="28" cy="92" r="1.6" fill="#ff8fb8"/>
      <circle cx="72" cy="92" r="1.6" fill="#ff8fb8"/>
      <!-- collar -->
      <path d="M 22,70 Q 26,74 31,71 Q 36,75 41,71 Q 46,75 50,71 Q 54,75 59,71 Q 64,75 69,71 Q 74,74 78,70 Q 74,80 50,81 Q 26,80 22,70 Z" fill="white"/>
      <!-- LEFT head — blue, winking -->
      <circle cx="24" cy="50" r="14" fill="url(#pup3HeadBlue)"/>
      <path d="M 14,40 L 8,22 L 20,38 Z" fill="#5a5fc0"/>
      <path d="M 16,36 L 14,26 L 19,35 Z" fill="#a8c7ff"/>
      <path d="M 32,40 L 36,26 L 27,38 Z" fill="#5a5fc0"/>
      <path d="M 31,36 L 34,30 L 29,36 Z" fill="#a8c7ff"/>
      <path d="M 18,50 Q 22,47 26,51" stroke="#15101e" stroke-width="1.3" fill="none" stroke-linecap="round"/>
      <ellipse cx="30" cy="50" rx="3" ry="4" fill="#15101e"/>
      <circle cx="29" cy="48" r="1.1" fill="white"/>
      <circle cx="31" cy="52" r="0.6" fill="white"/>
      <ellipse cx="24" cy="57" rx="1.7" ry="1.2" fill="#ff4fbf"/>
      <path d="M 21,61 Q 24,64 27,61" stroke="#15101e" stroke-width="1.2" fill="none" stroke-linecap="round"/>
      <!-- MIDDLE head — pink, biggest, big smile -->
      <circle cx="50" cy="40" r="17" fill="url(#pup3HeadPink)"/>
      <path d="M 36,28 L 30,8 L 44,24 Z" fill="#9655d6"/>
      <path d="M 39,22 L 36,12 L 43,21 Z" fill="#ff8fb8"/>
      <path d="M 64,28 L 70,8 L 56,24 Z" fill="#9655d6"/>
      <path d="M 61,22 L 64,12 L 57,21 Z" fill="#ff8fb8"/>
      <ellipse cx="43" cy="40" rx="4" ry="5.5" fill="#15101e"/>
      <circle cx="42" cy="38" r="1.4" fill="white"/>
      <circle cx="44" cy="43" r="0.8" fill="white"/>
      <ellipse cx="57" cy="40" rx="4" ry="5.5" fill="#15101e"/>
      <circle cx="56" cy="38" r="1.4" fill="white"/>
      <circle cx="58" cy="43" r="0.8" fill="white"/>
      <ellipse cx="50" cy="48" rx="2.2" ry="1.6" fill="#ff4fbf"/>
      <path d="M 45,53 Q 50,57 55,53" stroke="#15101e" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <circle cx="35" cy="46" r="2.5" fill="#ff8fb8" opacity="0.55"/>
      <circle cx="65" cy="46" r="2.5" fill="#ff8fb8" opacity="0.55"/>
      <!-- RIGHT head — blue, tongue out (mlem!) -->
      <circle cx="76" cy="50" r="14" fill="url(#pup3HeadBlue)"/>
      <path d="M 86,40 L 92,22 L 80,38 Z" fill="#5a5fc0"/>
      <path d="M 84,36 L 86,26 L 81,35 Z" fill="#a8c7ff"/>
      <path d="M 68,40 L 64,26 L 73,38 Z" fill="#5a5fc0"/>
      <path d="M 69,36 L 66,30 L 71,36 Z" fill="#a8c7ff"/>
      <ellipse cx="70" cy="50" rx="3" ry="4" fill="#15101e"/>
      <circle cx="69" cy="48" r="1.1" fill="white"/>
      <circle cx="71" cy="52" r="0.6" fill="white"/>
      <ellipse cx="82" cy="50" rx="3" ry="4" fill="#15101e"/>
      <circle cx="81" cy="48" r="1.1" fill="white"/>
      <circle cx="83" cy="52" r="0.6" fill="white"/>
      <ellipse cx="76" cy="57" rx="1.7" ry="1.2" fill="#ff4fbf"/>
      <!-- mouth + tongue -->
      <path d="M 73,61 Q 76,63 79,61" stroke="#15101e" stroke-width="1.2" fill="none" stroke-linecap="round"/>
      <path d="M 76,62 Q 76,68 79,68 Q 80,65 78,62 Z" fill="#ff8fb8"/>
    </svg>`,

  // STAGE 5: Big 3-headed Cerberus — final form, kawaii galaxy + crescent moon halo
  5: `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="cerbBody" cx="40%" cy="30%" r="80%">
          <stop offset="0%" stop-color="#ffc0e5"/>
          <stop offset="55%" stop-color="#b14bff"/>
          <stop offset="100%" stop-color="#3d1d61"/>
        </radialGradient>
        <radialGradient id="cerbHeadPink" cx="40%" cy="25%" r="85%">
          <stop offset="0%" stop-color="#ffd6f0"/>
          <stop offset="55%" stop-color="#c87aff"/>
          <stop offset="100%" stop-color="#4a1d8a"/>
        </radialGradient>
        <radialGradient id="cerbHeadBlue" cx="40%" cy="25%" r="85%">
          <stop offset="0%" stop-color="#c8d8ff"/>
          <stop offset="55%" stop-color="#7a8fff"/>
          <stop offset="100%" stop-color="#2a2f80"/>
        </radialGradient>
        <radialGradient id="moonGlow" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stop-color="#ffd84a" stop-opacity="0.7"/>
          <stop offset="100%" stop-color="#ffd84a" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <!-- glowing moon halo -->
      <circle cx="50" cy="10" r="9" fill="url(#moonGlow)"/>
      <path d="M 50,5 a 3.5,3.5 0 1 0 2.5,1.4 a 2.5,2.5 0 1 1 -2.5,-1.4" fill="#ffd84a"/>
      <!-- shadow + sparkles -->
      <ellipse cx="50" cy="92" rx="38" ry="4" fill="#ff4fbf" opacity="0.3"/>
      <circle cx="10" cy="40" r="0.9" fill="#ffffff" opacity="0.9"/>
      <circle cx="90" cy="40" r="0.9" fill="#ffd84a" opacity="0.9"/>
      <circle cx="14" cy="70" r="0.8" fill="#2ee6c8" opacity="0.9"/>
      <circle cx="86" cy="70" r="0.8" fill="#ffffff" opacity="0.9"/>
      <!-- floating hearts -->
      <path d="M 16,22 q -1,-2 -3,0 q 0,2 3,3.5 q 3,-1.5 3,-3.5 q -2,-2 -3,0" fill="#ff4fbf" opacity="0.8"/>
      <path d="M 84,22 q -1,-2 -3,0 q 0,2 3,3.5 q 3,-1.5 3,-3.5 q -2,-2 -3,0" fill="#ff4fbf" opacity="0.8"/>
      <!-- body -->
      <ellipse cx="50" cy="74" rx="38" ry="16" fill="url(#cerbBody)"/>
      <ellipse cx="50" cy="78" rx="22" ry="9" fill="#fff3df" opacity="0.95"/>
      <ellipse cx="24" cy="88" rx="6" ry="3.5" fill="#fff3df"/>
      <ellipse cx="76" cy="88" rx="6" ry="3.5" fill="#fff3df"/>
      <circle cx="24" cy="89" r="2" fill="#ff8fb8"/>
      <circle cx="76" cy="89" r="2" fill="#ff8fb8"/>
      <!-- tail -->
      <path d="M 86,72 Q 96,62 92,52" stroke="#b14bff" stroke-width="5" fill="none" stroke-linecap="round"/>
      <!-- collar with little pendant -->
      <path d="M 18,62 Q 24,67 30,63 Q 36,68 42,63 Q 48,68 50,63 Q 52,68 58,63 Q 64,68 70,63 Q 76,67 82,62 Q 78,74 50,75 Q 22,74 18,62 Z" fill="white"/>
      <circle cx="50" cy="76" r="2.4" fill="#ffd84a"/>
      <!-- LEFT head — blue, winking -->
      <circle cx="20" cy="44" r="15" fill="url(#cerbHeadBlue)"/>
      <path d="M 10,32 L 4,12 L 16,30 Z" fill="#5a5fc0"/>
      <path d="M 12,28 L 10,16 L 15,27 Z" fill="#a8c7ff"/>
      <path d="M 30,32 L 34,16 L 24,30 Z" fill="#5a5fc0"/>
      <path d="M 29,28 L 32,21 L 26,28 Z" fill="#a8c7ff"/>
      <path d="M 13,44 Q 18,40 22,45" stroke="#15101e" stroke-width="1.4" fill="none" stroke-linecap="round"/>
      <ellipse cx="27" cy="44" rx="3.2" ry="4.2" fill="#15101e"/>
      <circle cx="26" cy="42" r="1.2" fill="white"/>
      <circle cx="28" cy="46" r="0.7" fill="white"/>
      <ellipse cx="20" cy="51" rx="2" ry="1.4" fill="#ff4fbf"/>
      <path d="M 17,55 Q 20,58 23,55" stroke="#15101e" stroke-width="1.3" fill="none" stroke-linecap="round"/>
      <!-- MIDDLE head — pink, biggest, big smile -->
      <circle cx="50" cy="34" r="19" fill="url(#cerbHeadPink)"/>
      <path d="M 35,18 L 28,0 L 43,14 Z" fill="#9655d6"/>
      <path d="M 38,12 L 35,4 L 42,12 Z" fill="#ff8fb8"/>
      <path d="M 65,18 L 72,0 L 57,14 Z" fill="#9655d6"/>
      <path d="M 62,12 L 65,4 L 58,12 Z" fill="#ff8fb8"/>
      <ellipse cx="42" cy="34" rx="4.5" ry="6" fill="#15101e"/>
      <circle cx="41" cy="31" r="1.6" fill="white"/>
      <circle cx="43" cy="37" r="0.9" fill="white"/>
      <ellipse cx="58" cy="34" rx="4.5" ry="6" fill="#15101e"/>
      <circle cx="57" cy="31" r="1.6" fill="white"/>
      <circle cx="59" cy="37" r="0.9" fill="white"/>
      <ellipse cx="50" cy="44" rx="2.5" ry="1.8" fill="#ff4fbf"/>
      <path d="M 44,49 Q 50,54 56,49" stroke="#15101e" stroke-width="1.7" fill="none" stroke-linecap="round"/>
      <circle cx="33" cy="40" r="3" fill="#ff8fb8" opacity="0.55"/>
      <circle cx="67" cy="40" r="3" fill="#ff8fb8" opacity="0.55"/>
      <!-- RIGHT head — blue, tongue out -->
      <circle cx="80" cy="44" r="15" fill="url(#cerbHeadBlue)"/>
      <path d="M 90,32 L 96,12 L 84,30 Z" fill="#5a5fc0"/>
      <path d="M 88,28 L 90,16 L 85,27 Z" fill="#a8c7ff"/>
      <path d="M 70,32 L 66,16 L 76,30 Z" fill="#5a5fc0"/>
      <path d="M 71,28 L 68,21 L 74,28 Z" fill="#a8c7ff"/>
      <ellipse cx="73" cy="44" rx="3.2" ry="4.2" fill="#15101e"/>
      <circle cx="72" cy="42" r="1.2" fill="white"/>
      <circle cx="74" cy="46" r="0.7" fill="white"/>
      <ellipse cx="86" cy="44" rx="3.2" ry="4.2" fill="#15101e"/>
      <circle cx="85" cy="42" r="1.2" fill="white"/>
      <circle cx="87" cy="46" r="0.7" fill="white"/>
      <ellipse cx="80" cy="51" rx="2" ry="1.4" fill="#ff4fbf"/>
      <path d="M 77,55 Q 80,57 83,55" stroke="#15101e" stroke-width="1.3" fill="none" stroke-linecap="round"/>
      <path d="M 80,56 Q 80,62 83,62 Q 84,59 82,56 Z" fill="#ff8fb8"/>
    </svg>`,
};

// ============================================================
// 8) RENDER — paint the screen from the current state.
//    Called whenever something changes.
// ============================================================

// Track what we last drew for the pet so we don't reinject the SVG every
// tick. That reinjection used to wipe in-flight wiggle/heart animations.
let lastDrawnStageKey = "";

// Manage the "graduated pets" row inside the habitat. Only rebuilds the
// DOM when the count actually changes.
function renderGraduatedPets() {
  let container = document.getElementById("graduatedPets");
  if (!container) {
    container = document.createElement("div");
    container.id = "graduatedPets";
    container.className = "graduated-pets";
    // Insert before .pet-stage so the graduated pets appear to its left
    // when the habitat is flex-row.
    habitatEl.insertBefore(container, petStageEl);
  }
  const grads = state.graduated || [];
  if (container.dataset.count !== String(grads.length)) {
    container.innerHTML = "";
    grads.forEach(pet => {
      const wrap = document.createElement("div");
      wrap.className = "graduated-pet";
      wrap.title = pet.name + " · Cerberus";
      wrap.innerHTML = SVGS[STAGES.length - 1]; // full Cerberus SVG
      container.appendChild(wrap);
    });
    container.dataset.count = String(grads.length);
  }
}

function render() {
  // Pet name
  document.getElementById("petName").textContent = state.pet.name || "Your Pet";

  // Graduated pets (past Cerberuses) — shown small alongside the active pet
  renderGraduatedPets();

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
  } else if (state.pet.hunger < HUNGRY_THRESHOLD) {
    mood.textContent = "😢";
  } else if (state.pet.hunger > 80) {
    mood.textContent = "✨";
  } else {
    mood.textContent = "";
  }

  // Stat bar + numeric label + hover-tooltip explanation
  setBar("hungerFill", state.pet.hunger);
  updateStatLabel("hungerStat", "hungerValue", state.pet.hunger, buildHungerTooltip());

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
            <button class="diff-mini extra-hard" data-xp="50" data-diff="extra-hard">50</button>
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
  // Weekday progress toward next stage (capped display so it doesn't go past needed)
  const daysNow = Math.min(state.pet.survivedWeekdays, next.daysNeeded);
  caption.innerHTML =
    `${Math.floor(earned)} / ${needed} XP · ${daysNow} / ${next.daysNeeded} weekdays` +
    `<br>to ${next.name}`;
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
    const difficulty = btn.classList.contains("extra-hard") ? "extra-hard"
                     : btn.classList.contains("hard") ? "hard"
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

// ----- AMBIENT STARS in the habitat (galaxy mood) -----
function setupAmbientStars() {
  const symbols = ["✦", "✧", "⋆", "✶", "·"];
  for (let i = 0; i < 12; i++) {
    const star = document.createElement("span");
    star.className = "ambient-star";
    star.textContent = symbols[Math.floor(Math.random() * symbols.length)];
    star.style.top = (5 + Math.random() * 90) + "%";
    star.style.left = (3 + Math.random() * 94) + "%";
    star.style.fontSize = (8 + Math.random() * 10) + "px";
    star.style.animationDelay = (Math.random() * 4) + "s";
    star.style.animationDuration = (2.5 + Math.random() * 2.5) + "s";
    habitatEl.appendChild(star);
  }
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
