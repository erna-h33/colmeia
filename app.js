// ---------------------------------------------------------------------------
// Storage adapter.
// Everything else in this app talks to `Storage.get` / `Storage.set` only.
// This version uses Supabase when a signed-in user is present, and falls back
// to localStorage otherwise so the app still works while we build out sync.
// ---------------------------------------------------------------------------
const SUPABASE_URL = 'https://eopieetsbgulkjjpnzpz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_I5ReeJwMwFuDtKhWKqhm4g_iqJOt0X3';
let supabaseClient = null;

try {
  if (
    typeof window !== 'undefined' &&
    window.supabase &&
    typeof window.supabase.createClient === 'function'
  ) {
    supabaseClient = window.supabase.createClient(
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
    );
  }
} catch (error) {
  console.warn('Supabase unavailable, falling back to local mode.', error);
}

const Storage = {
  async get(key) {
    if (supabaseClient) {
      try {
        const {
          data: { session },
        } = await supabaseClient.auth.getSession();
        const user = session?.user;
        if (user) {
          const { data, error } = await supabaseClient
            .from('app_state')
            .select('value')
            .eq('user_id', user.id)
            .eq('key', key)
            .maybeSingle();
          if (!error && data?.value != null) {
            return { key, value: data.value };
          }
        }
      } catch (e) {
        console.error('storage get failed', e);
      }
    }

    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return { key, value: raw };
  },
  async set(key, value) {
    if (supabaseClient) {
      try {
        const {
          data: { session },
        } = await supabaseClient.auth.getSession();
        const user = session?.user;
        if (user) {
          const { error } = await supabaseClient.from('app_state').upsert(
            {
              user_id: user.id,
              key,
              value,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id,key' },
          );
          if (!error) return { key, value };
        }
      } catch (e) {
        console.error('storage set failed', e);
      }
    }

    localStorage.setItem(key, value);
    return { key, value };
  },
};

(function () {
  const KEY = 'planner_state_v1';
  const today0 = new Date();
  const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Turns a Date into a 'YYYY-MM-DD' string using LOCAL calendar fields.
  // Date.prototype.toISOString() converts to UTC first, which silently
  // shifts the date by a day in many timezones (the exact bug that made
  // "today" show up as tomorrow) -- this avoids that entirely.
  function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  let state = {
    events: [],
    tasks: [],
    notes: [],
    view: 'agenda',
    agendaMode: 'month',
    calYear: today0.getFullYear(),
    calMonth: today0.getMonth(),
    selectedDate: localDateStr(today0),
    darkMode: true,
    globalQuery: '',
    searchQuery: '',
    noteTagFilter: null,
    noteCategoryFilter: null,
    taskCategories: ['Shopping list', 'Odds & Ends', 'Work'],
    noteCategories: ['Idea', 'Link', 'Recipe', 'Gift idea', 'To read'],
  };
  let modal = null; // 'event' | 'task' | 'note' | 'export' | 'day:YYYY-MM-DD'
  let modalReturn = null;
  let editingEventId = null;
  let editingTaskId = null;
  let editingNoteId = null;
  let editingCategoryName = null; // which To Do category column is mid-rename, or null
  let authUser = null;
  let authMode = 'signin';
  let authReady = false;
  let authInitialized = false;
  let authError = '';
  let isLocalMode = false;
  let authMessage = '';
  let authEmail = '';
  let authPassword = '';
  // Set while a sign-in/sign-up call is in flight, so the onAuthStateChange
  // listener below knows to stay out of the way -- the submit handler is
  // already deciding what to do with the result (including, for sign-in,
  // possibly pausing to ask before replacing local guest data).
  let authFlowInProgress = false;
  // Holds the freshly-authenticated user between "credentials verified" and
  // "confirmed it's OK to replace local guest data with this account's
  // cloud data" during a sign-in. Null the rest of the time.
  let guestDataPendingReplace = null;
  // Id of the event awaiting the "you changed the date/time, add it to
  // Google Calendar again?" prompt (modal === 'readd-gcal'). Null the rest
  // of the time.
  let reAddGcalEventId = null;
  let syncStatus = 'Ready';
  let jokeOfTheDay = null;

  // Inline validation state. `fieldErrors` maps an input id -> true when it
  // failed validation on the last save attempt (shows "Required field" under
  // that input). The three drafts hold whatever the person had typed so far
  // if a save attempt fails, so re-rendering the modal to show the error
  // doesn't wipe out what they already filled in. No alerts, no popups.
  let fieldErrors = {};
  let eventDraft = null;
  let taskDraft = null;
  let noteDraft = null;
  let categoryDraft = null;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clearModalState() {
    editingCategoryName = null;
    modal = null;
    modalReturn = null;
  }

  function captureDraftFromForm() {
    if (modal === 'event') {
      const titleEl = document.getElementById('m-title');
      const typeEl = document.getElementById('m-type');
      const dateEl = document.getElementById('m-date');
      const timeEl = document.getElementById('m-time');
      const repeatEl = document.getElementById('m-repeat');
      eventDraft = {
        title: titleEl ? titleEl.value : '',
        type: typeEl ? typeEl.value : '',
        date: dateEl ? dateEl.value : '',
        time: timeEl ? timeEl.value : '',
        repeat: repeatEl ? repeatEl.value : 'none',
      };
    } else if (modal === 'task') {
      const textEl = document.getElementById('m-text');
      const dayEl = document.getElementById('m-day');
      const priorityEl = document.getElementById('m-priority');
      const categoryEl = document.getElementById('m-category');
      const newCategoryEl = document.getElementById('m-new-category');
      taskDraft = {
        text: textEl ? textEl.value : '',
        day: dayEl ? dayEl.value : '',
        priority: priorityEl ? priorityEl.value : 'med',
        category: categoryEl ? categoryEl.value : '',
        newCategory: newCategoryEl ? newCategoryEl.value : '',
      };
    } else if (modal === 'note') {
      const categoryEl = document.getElementById('m-category');
      const titleEl = document.getElementById('m-note-title');
      const bodyEl = document.getElementById('m-body');
      const tagsEl = document.getElementById('m-tags');
      const newCategoryEl = document.getElementById('m-new-category');
      noteDraft = {
        category: categoryEl ? categoryEl.value : '',
        title: titleEl ? titleEl.value : '',
        body: bodyEl ? bodyEl.value : '',
        tagsStr: tagsEl ? tagsEl.value : '',
        newCategory: newCategoryEl ? newCategoryEl.value : '',
      };
    } else if (modal === 'category') {
      const nameEl = document.getElementById('m-category-name');
      categoryDraft = nameEl ? nameEl.value : '';
    }
  }

  function snapshotDraftFromModal() {
    if (!modal) return;

    if (modal === 'event') {
      const titleEl = document.getElementById('m-title');
      const typeEl = document.getElementById('m-type');
      const dateEl = document.getElementById('m-date');
      const timeEl = document.getElementById('m-time');
      const repeatEl = document.getElementById('m-repeat');
      eventDraft = {
        title: titleEl ? titleEl.value : '',
        type: typeEl ? typeEl.value : '',
        date: dateEl ? dateEl.value : '',
        time: timeEl ? timeEl.value : '',
        repeat: repeatEl ? repeatEl.value : 'none',
      };
    } else if (modal === 'task') {
      const textEl = document.getElementById('m-text');
      const dayEl = document.getElementById('m-day');
      const priorityEl = document.getElementById('m-priority');
      const categoryEl = document.getElementById('m-category');
      const newCategoryEl = document.getElementById('m-new-category');
      taskDraft = {
        text: textEl ? textEl.value : '',
        day: dayEl ? dayEl.value : '',
        priority: priorityEl ? priorityEl.value : 'med',
        category: categoryEl ? categoryEl.value : '',
        newCategory: newCategoryEl ? newCategoryEl.value : '',
      };
    } else if (modal === 'note') {
      const categoryEl = document.getElementById('m-category');
      const titleEl = document.getElementById('m-note-title');
      const bodyEl = document.getElementById('m-body');
      const tagsEl = document.getElementById('m-tags');
      const newCategoryEl = document.getElementById('m-new-category');
      noteDraft = {
        category: categoryEl ? categoryEl.value : '',
        title: titleEl ? titleEl.value : '',
        body: bodyEl ? bodyEl.value : '',
        tagsStr: tagsEl ? tagsEl.value : '',
        newCategory: newCategoryEl ? newCategoryEl.value : '',
      };
    } else if (modal === 'category') {
      const nameEl = document.getElementById('m-category-name');
      categoryDraft = nameEl ? nameEl.value : '';
    }
  }

  function resetAgendaToToday() {
    const today = new Date();
    state.selectedDate = localDateStr(today);
    state.calYear = today.getFullYear();
    state.calMonth = today.getMonth();
  }

  async function load() {
    if (!authReady) {
      render();
      return;
    }

    syncStatus = authUser && !isLocalMode ? 'Loading…' : 'Loading…';
    render();

    try {
      const r = await Storage.get(KEY);
      if (r && r.value) {
        const loaded = JSON.parse(r.value);
        state = Object.assign({}, state, loaded);
        state.view = state.view || 'agenda';
        state.globalQuery = '';
        resetAgendaToToday();
        syncStatus =
          authUser && !isLocalMode ? 'Loaded from cloud' : 'Loaded locally';
      } else {
        // Confirmed there's genuinely nothing saved for this identity (as
        // opposed to a fetch error, handled below) -- clear out whatever
        // the previous identity had in memory instead of leaving it on
        // screen. This is what makes signing out (into a guest session
        // with no local data yet) actually look signed out.
        state.events = [];
        state.tasks = [];
        state.notes = [];
        state.taskCategories = ['Shopping list', 'Odds & Ends', 'Work'];
        state.noteCategories = [
          'Idea',
          'Link',
          'Recipe',
          'Gift idea',
          'To read',
        ];
        state.globalQuery = '';
        resetAgendaToToday();
        syncStatus =
          authUser && !isLocalMode
            ? 'No saved cloud data'
            : 'No saved local data';
      }
    } catch (e) {
      resetAgendaToToday();
      syncStatus =
        authUser && !isLocalMode
          ? 'Could not load cloud data'
          : 'Could not load local data';
    }
    render();
  }
  async function save() {
    try {
      await Storage.set(KEY, JSON.stringify(state));
      syncStatus =
        authUser && !isLocalMode ? 'Saved to cloud' : 'Saved locally';
    } catch (e) {
      syncStatus = 'Save failed';
      console.error('save failed', e);
    }
  }

  // Fetches a "joke of the day" for the sidebar footer, purely cosmetic.
  // Cached in its own localStorage key (separate from the Storage adapter
  // above -- this never touches account data or the Supabase sync path) so
  // it only refetches once per calendar day. Any failure (offline, API
  // down, blocked) just leaves jokeOfTheDay as null, and the sidebar falls
  // back to its normal static tagline -- never surfaces an error.
  async function loadJokeOfTheDay() {
    const CACHE_KEY = 'joke_of_the_day_v1';
    const today = localDateStr(new Date());
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && cached.date === today && cached.joke) {
        jokeOfTheDay = cached.joke;
        render();
        return;
      }
    } catch (e) {
      // ignore corrupt cache, fall through to a fresh fetch
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('https://icanhazdadjoke.com/', {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.joke) return;
      jokeOfTheDay = data.joke;
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ date: today, joke: data.joke }),
      );
      render();
    } catch (e) {
      // network error, timeout, blocked by CSP, etc. -- keep the fallback
      // tagline, no need to log this as a real error
    }
  }

  // People can use the whole app without an account -- data just lives in
  // this browser's localStorage (via the Storage adapter above) until they
  // choose to sign in/up to sync it. So "no session" is never a dead end
  // that blocks the UI; it just means isLocalMode.
  async function initAuth() {
    if (authInitialized) return;
    authInitialized = true;

    if (!supabaseClient) {
      authReady = true;
      isLocalMode = true;
      authUser = { id: 'local' };
      authError = '';
      render();
      load();
      return;
    }

    try {
      const {
        data: { session },
      } = await supabaseClient.auth.getSession();
      if (session?.user) {
        authUser = session.user;
        isLocalMode = false;
      } else {
        authUser = { id: 'local' };
        isLocalMode = true;
      }
      authReady = true;
      render();
      load();
    } catch (e) {
      authError = 'Could not initialize auth.';
      authReady = true;
      isLocalMode = true;
      authUser = { id: 'local' };
      render();
      load();
    }

    supabaseClient.auth.onAuthStateChange((event, session) => {
      // A sign-in/sign-up submit (or the guest-data confirm/cancel step it
      // may trigger) is already handling this explicitly -- don't race it.
      if (authFlowInProgress) return;
      authError = '';
      if (session?.user) {
        authUser = session.user;
        isLocalMode = false;
      } else {
        authUser = { id: 'local' };
        isLocalMode = true;
        if (event === 'SIGNED_OUT') authMessage = 'Signed out.';
      }
      authReady = true;
      load();
    });
  }

  // ---------- helpers ----------
  function fmtDay(dateStr) {
    const d = parseLocalDate(dateStr);
    return d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }
  function parseLocalDate(dateStr) {
    if (!dateStr) return new Date();
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(dateStr, n) {
    const d = parseLocalDate(dateStr);
    d.setDate(d.getDate() + n);
    return localDateStr(d);
  }
  function diffDaysBetween(d1, d2) {
    return Math.round(
      (parseLocalDate(d2).getTime() - parseLocalDate(d1).getTime()) / 86400000,
    );
  }
  function daysUntil(dateStr, timeStr) {
    const target = new Date(`${dateStr}T${timeStr || '23:59'}`);
    const diffMs = target - new Date();
    return diffMs / (1000 * 60 * 60);
  }
  function eventBadge(ev) {
    const hrs = daysUntil(ev.date, ev.time);
    if (hrs < 0) return { cls: 'overdue', label: 'Overdue' };
    if (hrs < 24) return { cls: 'soon', label: hrs < 1 ? 'Due now' : 'Today' };
    if (hrs < 48) return { cls: 'soon', label: 'Tomorrow' };
    return { cls: 'later', label: '' };
  }
  function eventOccursOnDate(ev, dateStr) {
    const rep = ev.repeat || 'none';
    if (rep === 'none') return ev.date === dateStr;
    const diff = diffDaysBetween(ev.date, dateStr);
    if (diff < 0) return false;
    if (rep === 'daily') return true;
    if (rep === 'weekly') return diff % 7 === 0;
    if (rep === 'monthly') {
      const base = parseLocalDate(ev.date);
      const d = parseLocalDate(dateStr);
      return base.getDate() === d.getDate();
    }
    return false;
  }
  function repeatLabel(ev) {
    const rep = ev.repeat || 'none';
    if (rep === 'none') return '';
    return (
      ' · 🔁 ' +
      (rep === 'daily' ? 'daily' : rep === 'weekly' ? 'weekly' : 'monthly')
    );
  }
  // ---------- Add to Google Calendar ----------
  // Reminders live on Google Calendar instead of a real push notification
  // system (this is a static site with no server to schedule sends from) --
  // this hands the actual reminding off to a calendar the person already
  // has, which does it reliably even when Beehive itself isn't open.
  //
  // This is a plain "quick add" link (calendar.google.com/render), not the
  // real Google Calendar API -- no OAuth, no server, nothing to set up. The
  // tradeoff: it can only ever CREATE an event, never edit one it already
  // created. If the date/time changes later, clicking it again adds a
  // second entry rather than moving the first one -- see the re-add prompt
  // below, which says as much.
  function gcalPad(n) {
    return String(n).padStart(2, '0');
  }
  function googleCalendarUrl(ev) {
    const [y, mo, d] = ev.date.split('-').map(Number);
    let datesParam;
    let ctz = null;
    if (ev.time) {
      const [hh, mm] = ev.time.split(':').map(Number);
      const start = `${y}${gcalPad(mo)}${gcalPad(d)}T${gcalPad(hh)}${gcalPad(mm)}00`;
      const endDate = new Date(y, mo - 1, d, hh, mm);
      endDate.setHours(endDate.getHours() + 1);
      const end = `${endDate.getFullYear()}${gcalPad(endDate.getMonth() + 1)}${gcalPad(endDate.getDate())}T${gcalPad(endDate.getHours())}${gcalPad(endDate.getMinutes())}00`;
      datesParam = `${start}/${end}`;
      // No Z suffix -- these are plain local wall-clock digits (the app has
      // no timezone concept at all), so tell Google which timezone to read
      // them in rather than letting it assume UTC.
      try {
        ctz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (e) {
        ctz = null;
      }
    } else {
      const start = `${y}${gcalPad(mo)}${gcalPad(d)}`;
      const nextDay = new Date(y, mo - 1, d);
      nextDay.setDate(nextDay.getDate() + 1);
      const end = `${nextDay.getFullYear()}${gcalPad(nextDay.getMonth() + 1)}${gcalPad(nextDay.getDate())}`;
      datesParam = `${start}/${end}`;
    }
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: ev.title,
      dates: datesParam,
    });
    if (ev.type) params.set('details', ev.type);
    if (ctz) params.set('ctz', ctz);
    const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' }[
      ev.repeat
    ];
    if (freq) params.set('recur', `RRULE:FREQ=${freq}`);
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }
  function priorityDot(p) {
    return `<span class="prio-dot ${p || 'med'}"></span>`;
  }
  function isUrl(str) {
    if (!str) return false;
    try {
      const u = new URL(str.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }
  function fmtShortDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
    } catch (e) {
      return '';
    }
  }
  function fmtFullDateTime(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const day = d.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const time = d.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
      return `${day} · ${time}`;
    } catch (e) {
      return '';
    }
  }
  // Legacy notes were saved with `kind` (idea/link) instead of `category`.
  // This keeps them displaying sensibly without needing a migration step.
  function noteCategoryLabel(n) {
    if (n.category) return n.category;
    if (n.kind === 'link') return 'Link';
    if (n.kind === 'idea') return 'Idea';
    return '';
  }
  // Color per category -- spread across distinct hues (not just shades of
  // the same amber/brown) so adjacent categories are easy to tell apart at
  // a glance. When `list` (the board's actual category order) is given,
  // color is assigned by position in that list, so two categories shown
  // side by side never collide as long as there are <= 8 of them. Falls
  // back to a hash of the name when the category isn't found in `list`
  // (e.g. a legacy note label not in state.noteCategories).
  const CATEGORY_PALETTE = [
    '#E0433D',
    '#E8A33D',
    '#4C9A4C',
    '#2E8B8B',
    '#3A6EA5',
    '#7A4B8C',
    '#C04670',
    '#A6742E',
  ];
  function categoryColor(name, list) {
    if (!name) return null;
    const idx = list ? list.indexOf(name) : -1;
    if (idx !== -1) return CATEGORY_PALETTE[idx % CATEGORY_PALETTE.length];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length];
  }
  // Picks readable text color (near-black or white) against a given hex
  // background, so badges stay legible regardless of which palette color
  // they land on.
  function categoryTextColor(hex) {
    if (!hex) return 'var(--ink)';
    const r = parseInt(hex.slice(1, 3), 16),
      g = parseInt(hex.slice(3, 5), 16),
      b = parseInt(hex.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? '#2B3A36' : '#FFFFFF';
  }

  // Small line-icon set (Feather/Lucide-style: 24x24 viewbox, 2px stroke,
  // rounded caps). Uses currentColor so it inherits the button's text color
  // automatically, including on hover/active states -- no separate color
  // rules needed.
  const ICONS = {
    calendar:
      '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>',
    checkSquare:
      '<rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="m9 12 2 2 4-4"></path>',
    fileText:
      '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line>',
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>',
    sun: '<circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"></line><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"></line><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"></line>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>',
    edit: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>',
    trash:
      '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
    check: '<polyline points="20 6 9 17 4 12"></polyline>',
    x: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
  };
  function icon(name) {
    return `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  }
  function actionIcon(name) {
    return `<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  }

  // ---------- render root ----------
  function render() {
    const app = document.getElementById('app');
    app.className = state.darkMode ? 'dark' : '';

    if (!authReady) {
      app.innerHTML = `<div class="auth-shell"><div class="auth-card"><div class="brand">Beehive<span>.</span></div><h1>Connecting…</h1><p>Preparing your planner.</p></div></div>`;
      return;
    }

    app.innerHTML = `
      ${sidebar()}
      <div class="main">${viewBody()}</div>
      <div class="mobile-joke">${jokeOfTheDay ? `"${escapeHtml(jokeOfTheDay)}"` : 'Everything you need to track, in one place.'}</div>
      ${modal ? renderModal() : ''}
    `;
    bindEvents();
  }

  // Rendered twice: once in its normal spot in .sidebar-tools (desktop, and
  // the mobile nav-scroll strip), and once as a duplicate paired with the
  // logo in .mobile-account-row (phones only). CSS shows exactly one of the
  // two per breakpoint -- see .account-btn-original / .account-btn-mobile.
  // Both carry the same data-attributes, so the existing click handlers
  // (already using querySelectorAll) wire up both automatically.
  function accountButton(variant) {
    const extraClass = variant === 'mobile' ? 'account-btn-mobile' : 'account-btn-original';
    if (isLocalMode) {
      return `<button class="side-btn ${extraClass}" data-open-modal="auth"><span>🔐</span> <span>Sign in to save</span></button>`;
    }
    return `<button class="side-btn ${extraClass}" data-auth-signout><span class="avatar" title="${escapeAttr(authUser.email || '')}">${escapeHtml((authUser.email || '?').charAt(0).toUpperCase())}</span> <span>Sign out</span></button>`;
  }

  // Same rendered-twice pattern as accountButton() above. The mobile copy
  // is icon-only (no "Light mode"/"Dark mode" label) since it sits in the
  // cramped top bar next to the logo; the desktop/original copy keeps its
  // label.
  function darkModeButton(variant) {
    const icon_ = icon(state.darkMode ? 'sun' : 'moon');
    if (variant === 'mobile') {
      return `<button class="side-btn darkmode-btn-mobile" data-toggle-dark title="${state.darkMode ? 'Light mode' : 'Dark mode'}">${icon_}</button>`;
    }
    return `<button class="side-btn darkmode-btn-original" data-toggle-dark>${icon_} <span>${state.darkMode ? 'Light mode' : 'Dark mode'}</span></button>`;
  }

  function sidebar() {
    const eventCount = state.events.length;
    const openTasks = state.tasks.filter((t) => !t.done).length;
    return `
    <div class="sidebar">
      <div class="mobile-account-row">
        <div class="brand">Beehive<span>.</span></div>
        ${darkModeButton('mobile')}
        ${accountButton('mobile')}
      </div>
      <input class="global-search" placeholder="Search everything…" value="${escapeAttr(state.globalQuery || '')}" data-global-search />
      <div class="nav-scroll">
        <button class="nav-btn ${state.view === 'agenda' && !state.globalQuery ? 'active' : ''}" data-view="agenda">
          ${icon('calendar')} <span>Agenda</span> <span class="count">${eventCount}</span>
        </button>
        <button class="nav-btn ${state.view === 'week' && !state.globalQuery ? 'active' : ''}" data-view="week">
          ${icon('checkSquare')} <span>To Do</span> <span class="count">${openTasks}</span>
        </button>
        <button class="nav-btn ${state.view === 'notes' && !state.globalQuery ? 'active' : ''}" data-view="notes">
          ${icon('fileText')} <span>Notes</span> <span class="count">${state.notes.length}</span>
        </button>
        <div class="sidebar-tools">
          ${darkModeButton('original')}
          <button class="side-btn" data-open-modal="export">${icon('download')} <span>Export data</span></button>
          ${accountButton('original')}
          <div class="sidebar-foot">
            <div class="sync-status">${escapeHtml(syncStatus)}</div>
            ${jokeOfTheDay ? `"${escapeHtml(jokeOfTheDay)}"` : 'Everything you need to track, in one place.'}
          </div>
        </div>
      </div>
    </div>`;
  }

  function viewBody() {
    if (state.globalQuery && state.globalQuery.trim())
      return searchResultsView();
    if (state.view === 'agenda') return agendaView();
    if (state.view === 'week') return weekView();
    return notesView();
  }

  // ---------- Global search ----------
  function searchResultsView() {
    const q = state.globalQuery.toLowerCase().trim();
    const evMatches = state.events.filter(
      (e) =>
        e.title.toLowerCase().includes(q) ||
        (e.type || '').toLowerCase().includes(q),
    );
    const taskMatches = state.tasks.filter((t) =>
      t.text.toLowerCase().includes(q),
    );
    const noteMatches = state.notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        (n.body || '').toLowerCase().includes(q),
    );

    let body = '';
    if (evMatches.length) {
      body += `<div class="search-section-title">Agenda</div>`;
      evMatches.forEach((ev) => {
        body += `<div class="result-row" data-goto-event-date="${ev.date}">
          <div class="event-time">${ev.time || '--:--'}</div>
          <div style="flex:1"><div class="event-title">${escapeHtml(ev.title)}</div><div class="result-meta">${fmtDay(ev.date)}</div></div>
        </div>`;
      });
    }
    if (taskMatches.length) {
      body += `<div class="search-section-title">To Do</div>`;
      taskMatches.forEach((t) => {
        body += `<div class="result-row" data-goto-week>
          <div style="flex:1">${priorityDot(t.priority)}${escapeHtml(t.text)}</div>
          <div class="result-meta">${t.day || 'No day'}</div>
        </div>`;
      });
    }
    if (noteMatches.length) {
      body += `<div class="search-section-title">Notes</div>`;
      noteMatches.forEach((n) => {
        body += `<div class="result-row" data-goto-notes>
          <span class="note-kind ${n.kind}" style="font-size:9px;">${n.kind}</span>
          <div style="flex:1">${escapeHtml(n.title)}</div>
        </div>`;
      });
    }
    if (!evMatches.length && !taskMatches.length && !noteMatches.length) {
      body = `<div class="empty">No matches for "${escapeHtml(state.globalQuery)}".</div>`;
    }

    return `
      <div class="view-head">
        <div>
          <h2 class="view-title">Search results</h2>
          <div class="view-sub">Across Agenda, To Do, and Notes & Links.</div>
        </div>
        <button class="btn ghost" data-clear-search>Clear search</button>
      </div>
      ${body}
    `;
  }

  // ---------- Agenda ----------
  function agendaView() {
    const header = `
      <div class="view-head">
        <div>
          <h2 class="view-title">Agenda</h2>
          <div class="view-sub">Meetings, bills, appointments — with reminders.</div>
        </div>
        <div style="display:flex; gap:10px; align-items:center;">
          <div class="view-toggle">
            <button class="${state.agendaMode === 'month' ? 'active' : ''}" data-agenda-mode="month">Month</button>
            <button class="${state.agendaMode === 'list' ? 'active' : ''}" data-agenda-mode="list">List</button>
          </div>
          <button class="btn" data-open-modal="event">+ Add event</button>
        </div>
      </div>
    `;
    return (
      header + (state.agendaMode === 'month' ? monthGridBody() : listBody())
    );
  }

  function listBody() {
    const todayD = new Date();
    const startD = new Date(todayD);
    startD.setDate(startD.getDate() - 30);
    const endD = new Date(todayD);
    endD.setDate(endD.getDate() + 180);
    const toStr = (d) => localDateStr(d);

    let occurrences = [];
    state.events.forEach((ev) => {
      if ((ev.repeat || 'none') === 'none') {
        occurrences.push(ev);
      } else {
        for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
          const ds = toStr(d);
          if (eventOccursOnDate(ev, ds))
            occurrences.push(Object.assign({}, ev, { date: ds }));
        }
      }
    });

    const sorted = occurrences.sort((a, b) =>
      (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')),
    );
    let groups = {};
    sorted.forEach((ev) => {
      (groups[ev.date] = groups[ev.date] || []).push(ev);
    });
    const dateKeys = Object.keys(groups).sort();

    if (dateKeys.length === 0) {
      return `<div class="empty">No events yet. Add a meeting, bill, or appointment — with a reminder so it never slips by.</div>`;
    }
    let body = '';
    dateKeys.forEach((dk) => {
      body += `<div class="day-label">${fmtDay(dk)}</div>`;
      groups[dk].forEach((ev) => {
        body += eventCard(ev);
      });
    });
    return body;
  }

  function eventCard(ev) {
    const badge = eventBadge(ev);
    const isRecurring = ev.repeat && ev.repeat !== 'none';
    return `
      <div class="card">
        <div class="event-row">
          <div class="event-time">${ev.time || '--:--'}</div>
          <div style="flex:1">
            <div class="event-title">${escapeHtml(ev.title)}</div>
            <div class="event-type">${escapeHtml(ev.type)}${repeatLabel(ev)}</div>
          </div>
          ${badge.label ? `<div class="badge ${badge.cls}">${badge.label}</div>` : ''}
        </div>
        <div class="row-actions">
          <button class="icon-btn" data-edit-event="${ev.id}">✎ Edit</button>
          <a class="icon-btn" href="${escapeAttr(googleCalendarUrl(ev))}" target="_blank" rel="noopener" data-gcal-link="${ev.id}">📅 Add to Google Calendar</a>
          ${!isRecurring ? `<button class="icon-btn" data-snooze-event="${ev.id}">⏰ Snooze +1d</button>` : ''}
          <button class="icon-btn danger" data-del-event="${ev.id}">Delete</button>
        </div>
      </div>`;
  }

  function monthGridBody() {
    const y = state.calYear,
      m = state.calMonth;
    const first = new Date(y, m, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const daysInPrevMonth = new Date(y, m, 0).getDate();
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
    const todayStr = localDateStr(new Date());

    let cells = '';
    for (let i = 0; i < totalCells; i++) {
      let cellY = y,
        cellM = m,
        dayNum;
      let outside = false;
      if (i < startOffset) {
        dayNum = daysInPrevMonth - startOffset + i + 1;
        cellM = m - 1;
        if (cellM < 0) {
          cellM = 11;
          cellY--;
        }
        outside = true;
      } else if (i >= startOffset + daysInMonth) {
        dayNum = i - (startOffset + daysInMonth) + 1;
        cellM = m + 1;
        if (cellM > 11) {
          cellM = 0;
          cellY++;
        }
        outside = true;
      } else {
        dayNum = i - startOffset + 1;
      }
      const dateStr = `${cellY}-${String(cellM + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
      const dayEvents = state.events.filter((ev) =>
        eventOccursOnDate(ev, dateStr),
      );
      const dots = dayEvents
        .slice(0, 4)
        .map(
          (ev) =>
            `<div class="day-dot ${eventBadge(Object.assign({}, ev, { date: dateStr })).cls || 'later'}"></div>`,
        )
        .join('');
      const cls = ['day-cell'];
      if (outside) cls.push('outside');
      if (dateStr === todayStr) cls.push('today');
      if (dateStr === state.selectedDate) cls.push('selected');
      cells += `<div class="${cls.join(' ')}" data-day="${dateStr}">
        <div class="day-num">${dayNum}</div>
        <div class="day-dots">${dots}</div>
      </div>`;
    }

    const monthLabel = first.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    const dayEvents = state.events
      .filter((ev) => eventOccursOnDate(ev, state.selectedDate))
      .map((ev) => Object.assign({}, ev, { date: state.selectedDate }))
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    return `
      <div class="month-nav">
        <button data-month-nav="-1">‹</button>
        <div class="month-label">${monthLabel}</div>
        <button data-month-nav="1">›</button>
        <button class="today-btn" data-month-today>Today</button>
      </div>
      <div class="grid-wrap">
        <div class="grid-weekdays">${weekDays.map((d) => `<div>${d}</div>`).join('')}</div>
        <div class="grid-days">${cells}</div>
      </div>
      <div class="day-panel">
        <div class="day-label">${fmtDay(state.selectedDate)}</div>
        ${dayEvents.length ? dayEvents.map((ev) => eventCard(ev)).join('') : `<div class="empty" style="padding:20px 10px;">Nothing on this day.</div>`}
      </div>
    `;
  }

  // ---------- To Do ----------
  function weekView() {
    const columns = state.taskCategories.slice();
    const byCat = {};
    columns.forEach((c) => (byCat[c] = []));
    byCat['—'] = [];
    state.tasks.forEach((t) => {
      const c = t.category && columns.includes(t.category) ? t.category : '—';
      byCat[c].push(t);
    });
    if (byCat['—'].length) columns.push('—');

    let body = '';
    if (state.tasks.length === 0 && columns.length <= 1) {
      body = `<div class="empty">Nothing on the list yet. Add what you'd normally text yourself or write on paper.</div>`;
    } else {
      body =
        `<div class="category-grid">` +
        columns
          .map((cat) => {
            const items = byCat[cat] || [];
            const isReal = cat !== '—';
            const color = categoryColor(cat, columns);
            const renaming = editingCategoryName === cat;
            const headLeft = renaming
              ? `<input type="text" id="cat-rename-input" value="${escapeAttr(cat)}" style="font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:15px; padding:3px 6px; border-radius:8px; border:1.5px solid var(--line); width:100%;" />`
              : `<span><span class="cat-dot" style="${color ? `background:${color};` : ''}"></span>${cat === '—' ? 'No category' : escapeHtml(cat)}</span>`;
            const headActions = renaming
              ? `<button class="icon-btn" data-save-category-rename="${escapeAttr(cat)}" title="Save name">${actionIcon('check')}</button>
             <button class="icon-btn" data-cancel-category-rename title="Cancel">${actionIcon('x')}</button>`
              : isReal
                ? `<button class="icon-btn" data-add-to-category="${escapeAttr(cat)}" title="Add item to ${escapeAttr(cat)}">${actionIcon('plus')}</button>
               <button class="icon-btn" data-edit-category="${escapeAttr(cat)}" title="Rename category">${actionIcon('edit')}</button>
               <button class="icon-btn danger" data-delete-category="${escapeAttr(cat)}" title="Delete category and its items">${actionIcon('trash')}</button>`
                : '';
            return `
          <div class="category-col" style="${color ? `border-left-color:${color};` : ''}">
            <div class="category-col-head">
              ${headLeft}
              <div class="cat-head-actions">
                ${headActions}
                <span class="cat-count">${items.length}</span>
              </div>
            </div>
            ${renaming ? fieldError('cat-rename-input') : ''}
            ${items.length ? items.map((t) => taskItem(t)).join('') : `<div class="empty" style="padding:16px 6px; font-size:14px;">Nothing here yet.</div>`}
          </div>
        `;
          })
          .join('') +
        `</div>`;
    }

    return `
      <div class="view-head">
        <div>
          <h2 class="view-title">To Do</h2>
          <div class="view-sub">Shopping lists, errands, work — split by category.</div>
        </div>
        <button class="btn" data-open-modal="category">+ Add category</button>
      </div>
      ${body}
    `;
  }

  function taskItem(t) {
    return `
      <div class="task-item">
        <div class="checkbox ${t.done ? 'done' : ''}" data-toggle-task="${t.id}">
          ${t.done ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg>' : ''}
        </div>
        <div class="task-main">
          <div class="task-text ${t.done ? 'done' : ''}">${priorityDot(t.priority)}${escapeHtml(t.text)}</div>
          ${t.day ? `<span class="task-day">${t.day}</span>` : ''}
        </div>
        <div class="row-actions">
          <button class="icon-btn" data-edit-task="${t.id}" title="Edit">${actionIcon('edit')}</button>
          <button class="icon-btn danger" data-del-task="${t.id}" title="Delete">${actionIcon('trash')}</button>
        </div>
      </div>`;
  }

  // ---------- Notes ----------
  function notesView() {
    const q = (state.searchQuery || '').toLowerCase().trim();
    const allTags = [
      ...new Set(state.notes.flatMap((n) => n.tags || [])),
    ].sort();
    const allCats = [
      ...new Set(state.notes.map((n) => noteCategoryLabel(n)).filter(Boolean)),
    ].sort();
    const filtered = state.notes.filter(
      (n) =>
        (!q ||
          n.title.toLowerCase().includes(q) ||
          (n.body || '').toLowerCase().includes(q)) &&
        (!state.noteTagFilter ||
          (n.tags || []).includes(state.noteTagFilter)) &&
        (!state.noteCategoryFilter ||
          noteCategoryLabel(n) === state.noteCategoryFilter),
    );
    let grid = '';
    if (filtered.length === 0) {
      grid = `<div class="empty">${state.notes.length ? 'No matches. Try another search term, category, or tag.' : 'Save an idea or a link here so it is easy to find and manage.'}</div>`;
    } else {
      grid =
        `<div class="notes-grid">` +
        filtered
          .map((n) => {
            const cat = noteCategoryLabel(n);
            const color = categoryColor(cat, state.noteCategories);
            const linkBody = isUrl(n.body);
            return `
        <div class="note-card">
          ${cat ? `<div class="note-kind" style="${color ? `background:${color}; color:${categoryTextColor(color)};` : ''}">${escapeHtml(cat)}</div>` : ''}
          ${n.createdAt ? `<div class="note-dates">Created ${fmtFullDateTime(n.createdAt)}</div>` : ''}
          <div class="note-title">${escapeHtml(n.title)}</div>
          <div class="note-body">${linkBody ? `<a href="${escapeAttr(n.body)}" target="_blank" rel="noopener">${escapeHtml(n.body)}</a>` : escapeHtml(n.body || '')}</div>
          ${n.tags && n.tags.length ? `<div class="note-tags">${n.tags.map((t) => `<span class="note-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
          ${n.updatedAt ? `<div class="note-dates">Updated ${fmtFullDateTime(n.updatedAt)}</div>` : ''}
          <div class="row-actions">
            <button class="icon-btn" data-edit-note="${n.id}">✎ Edit</button>
            <button class="icon-btn danger" data-del-note="${n.id}">Delete</button>
          </div>
        </div>
      `;
          })
          .join('') +
        `</div>`;
    }

    return `
      <div class="view-head">
        <div>
          <h2 class="view-title">Notes</h2>
          <div class="view-sub">Searchable — and clip any of these onto a reminder.</div>
        </div>
        <button class="btn" data-open-modal="note">+ Add note</button>
      </div>
      <input class="search-bar" placeholder="Search your notes and links…" value="${escapeAttr(state.searchQuery || '')}" data-search />
      ${
        allCats.length
          ? `<div class="tag-row">
        <button class="tag-chip ${!state.noteCategoryFilter ? 'active' : ''}" data-category-filter="">All categories</button>
        ${allCats.map((c) => `<button class="tag-chip ${state.noteCategoryFilter === c ? 'active' : ''}" data-category-filter="${escapeAttr(c)}">${escapeHtml(c)}</button>`).join('')}
      </div>`
          : ''
      }
      ${
        allTags.length
          ? `<div class="tag-row">
        <button class="tag-chip ${!state.noteTagFilter ? 'active' : ''}" data-tag-filter="">All tags</button>
        ${allTags.map((t) => `<button class="tag-chip ${state.noteTagFilter === t ? 'active' : ''}" data-tag-filter="${escapeAttr(t)}">${escapeHtml(t)}</button>`).join('')}
      </div>`
          : ''
      }
      ${grid}
    `;
  }

  // ---------- Modals ----------
  function renderModal() {
    if (modal === 'auth') {
      if (guestDataPendingReplace) {
        const counts = [
          state.events.length === 1
            ? '1 event'
            : `${state.events.length} events`,
          state.tasks.length === 1
            ? '1 to-do item'
            : `${state.tasks.length} to-do items`,
          state.notes.length === 1 ? '1 note' : `${state.notes.length} notes`,
        ].join(', ');
        return `<div class="overlay" data-overlay>
          <div class="modal" style="width:440px;">
            <h3>Replace your trial data?</h3>
            <p style="margin:0 0 16px 0; color:var(--muted);">You're signing in as <strong>${escapeHtml(guestDataPendingReplace.email || '')}</strong>, and that account already has data saved in the cloud. Continuing will replace what you've added here (${counts}) with your account's saved data. This can't be undone.</p>
            <div class="modal-actions">
              <button class="btn ghost" data-auth-cancel-replace>Keep my trial data</button>
              <button class="btn" data-auth-confirm-replace>Replace with my account data</button>
            </div>
          </div>
        </div>`;
      }
      return `<div class="overlay" data-overlay>
        <div class="modal" style="width:400px;">
          <h3>${authMode === 'signin' ? 'Sign in' : 'Create account'}</h3>
          <p style="margin:0 0 14px 0; color:var(--muted); font-size:var(--font-size-small);">${authMode === 'signin' ? 'Sign in to sync your planner across devices.' : 'Create an account to save your planner and access it anywhere.'}</p>
          <div class="field"><label>Email</label><input type="email" id="m-auth-email" value="${escapeAttr(authEmail)}" placeholder="you@example.com" /></div>
          <div class="field"><label>Password</label><input type="password" id="m-auth-password" value="${escapeAttr(authPassword)}" placeholder="••••••••" /></div>
          ${authError ? `<div class="auth-error">${escapeHtml(authError)}</div>` : ''}
          ${authMessage ? `<div class="auth-message">${escapeHtml(authMessage)}</div>` : ''}
          <div class="modal-actions">
            <button class="btn ghost" data-close-modal>Cancel</button>
            <button class="btn ghost" type="button" data-auth-toggle-mode>${authMode === 'signin' ? 'Need an account?' : 'Have an account?'}</button>
            <button class="btn" data-auth-submit>${authMode === 'signin' ? 'Sign in' : 'Create account'}</button>
          </div>
        </div>
      </div>`;
    }
    if (modal === 'event') {
      const existing = editingEventId
        ? state.events.find((e) => e.id === editingEventId)
        : null;
      const src =
        eventDraft ||
        (existing
          ? {
              title: existing.title,
              type: existing.type,
              date: existing.date,
              time: existing.time || '',
              repeat: existing.repeat || 'none',
            }
          : null);
      const defaultDate = src ? src.date : state.selectedDate;
      const types = [
        'Meeting',
        'Bill payment',
        'Appointment',
        'Deadline',
        'Other',
      ];
      const repeats = [
        ['none', 'Does not repeat'],
        ['daily', 'Daily'],
        ['weekly', 'Weekly'],
        ['monthly', 'Monthly'],
      ];
      return `<div class="overlay" data-overlay>
        <div class="modal">
          <h3>${existing ? 'Edit event' : 'Add event'}</h3>
          <div class="field"><label>What is it? ${requiredMark()}</label><input type="text" id="m-title" value="${escapeAttr(src ? src.title : '')}" placeholder="e.g. Dentist appointment" />${fieldError('m-title')}</div>
          <div class="field"><label>Type</label>
            <select id="m-type">
              ${types.map((t) => `<option ${src && src.type === t ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="field-row">
            <div class="field"><label>Date ${requiredMark()}</label><input type="date" id="m-date" value="${escapeAttr(defaultDate || '')}" />${fieldError('m-date')}</div>
            <div class="field"><label>Time</label><input type="time" id="m-time" value="${escapeAttr(src ? src.time || '' : '')}" /></div>
          </div>
          <div class="field"><label>Repeat</label>
            <select id="m-repeat">
              ${repeats.map(([v, l]) => `<option value="${v}" ${src && (src.repeat || 'none') === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="modal-actions">
            ${existing ? `<button class="btn ghost" data-delete-event-inmodal="${existing.id}" style="margin-right:auto; color:var(--clay); border-color:#EAD0C4;">Delete</button>` : ''}
            <button class="btn ghost" data-close-modal>Cancel</button>
            <button class="btn" data-save-event>${existing ? 'Save changes' : 'Save'}</button>
          </div>
        </div>
      </div>`;
    }
    if (modal === 'readd-gcal') {
      const ev = state.events.find((e) => e.id === reAddGcalEventId);
      if (!ev) {
        modal = modalReturn;
        modalReturn = null;
        return renderModal();
      }
      return `<div class="overlay" data-overlay>
        <div class="modal" style="width:420px;">
          <h3>Update Google Calendar?</h3>
          <p style="margin:0 0 16px 0; color:var(--muted);">This adds a new entry for "<strong>${escapeHtml(ev.title)}</strong>" -- delete the old one yourself.</p>
          <div class="modal-actions">
            <button class="btn ghost" data-gcal-dismiss>Not now</button>
            <button class="btn" data-gcal-readd>Add again</button>
          </div>
        </div>
      </div>`;
    }
    if (modal === 'task') {
      const existing = editingTaskId
        ? state.tasks.find((t) => t.id === editingTaskId)
        : null;
      const src =
        taskDraft ||
        (existing
          ? {
              text: existing.text,
              day: existing.day,
              priority: existing.priority,
              category: existing.category || '',
              newCategory: '',
            }
          : null);
      const showNewCat = src && src.category === '__new__';
      return `<div class="overlay" data-overlay>
        <div class="modal">
          <h3>${existing ? 'Edit to-do' : 'Add to-do'}</h3>
          <div class="field"><label>Item ${requiredMark()}</label><input type="text" id="m-text" value="${escapeAttr(src ? src.text : '')}" placeholder="e.g. Buy mum's birthday gift" />${fieldError('m-text')}</div>
          <div class="field"><label>Category</label>
            <select id="m-category">
              <option value="">No category</option>
              ${state.taskCategories.map((c) => `<option value="${escapeAttr(c)}" ${src && src.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
              <option value="__new__" ${showNewCat ? 'selected' : ''}>+ New category…</option>
            </select>
          </div>
          <div class="field" id="m-new-cat-wrap" style="${showNewCat ? '' : 'display:none;'}">
            <label>New category name ${requiredMark()}</label>
            <input type="text" id="m-new-category" value="${escapeAttr(src && src.newCategory ? src.newCategory : '')}" placeholder="e.g. Fitness" />${fieldError('m-new-category')}
          </div>
          <div class="field-row">
            <div class="field"><label>Day (optional)</label>
              <select id="m-day">
                <option value="">No day</option>
                ${weekDays.map((d) => `<option ${src && src.day === d ? 'selected' : ''}>${d}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label>Priority</label>
              <select id="m-priority">
                <option value="low" ${src && src.priority === 'low' ? 'selected' : ''}>Low</option>
                <option value="med" ${!src || src.priority === 'med' ? 'selected' : ''}>Medium</option>
                <option value="high" ${src && src.priority === 'high' ? 'selected' : ''}>High</option>
              </select>
            </div>
          </div>
          <div class="modal-actions">
            ${existing ? `<button class="btn ghost" data-delete-task-inmodal="${existing.id}" style="margin-right:auto; color:var(--clay); border-color:#EAD0C4;">Delete</button>` : ''}
            <button class="btn ghost" data-close-modal>Cancel</button>
            <button class="btn" data-save-task>${existing ? 'Save changes' : 'Save'}</button>
          </div>
        </div>
      </div>`;
    }
    if (modal === 'category') {
      const value = categoryDraft != null ? categoryDraft : '';
      return `<div class="overlay" data-overlay>
        <div class="modal" style="width:400px;">
          <h3>Add category</h3>
          <div class="field"><label>Category name ${requiredMark()}</label><input type="text" id="m-category-name" value="${escapeAttr(value)}" placeholder="e.g. Fitness" />${fieldError('m-category-name')}</div>
          <div class="modal-actions">
            <button class="btn ghost" data-close-modal>Cancel</button>
            <button class="btn" data-save-category>Save</button>
          </div>
        </div>
      </div>`;
    }
    if (modal === 'note') {
      const existing = editingNoteId
        ? state.notes.find((n) => n.id === editingNoteId)
        : null;
      const src =
        noteDraft ||
        (existing
          ? {
              category:
                existing.category ||
                (existing.kind === 'link'
                  ? 'Link'
                  : existing.kind === 'idea'
                    ? 'Idea'
                    : ''),
              title: existing.title,
              body: existing.body,
              tagsStr: (existing.tags || []).join(', '),
              newCategory: '',
            }
          : null);
      const showNewCat = src && src.category === '__new__';
      const bodyIsUrl = isUrl(src ? src.body : '');
      return `<div class="overlay" data-overlay>
        <div class="modal">
          <h3>${existing ? 'Edit' : 'Note'}</h3>
          <div class="field"><label>Category</label>
            <select id="m-category">
              <option value="">No category</option>
              ${state.noteCategories.map((c) => `<option value="${escapeAttr(c)}" ${src && src.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
              <option value="__new__" ${showNewCat ? 'selected' : ''}>+ New category…</option>
            </select>
          </div>
          <div class="field" id="m-new-cat-wrap" style="${showNewCat ? '' : 'display:none;'}">
            <label>New category name ${requiredMark()}</label>
            <input type="text" id="m-new-category" value="${escapeAttr(src && src.newCategory ? src.newCategory : '')}" placeholder="e.g. Recipe" />${fieldError('m-new-category')}
          </div>
          <div class="field"><label>Title ${!bodyIsUrl ? requiredMark() : ''}</label><input type="text" id="m-note-title" value="${escapeAttr(src ? src.title : '')}" placeholder="Short label so you can find it again (optional if you paste a link below)" />${fieldError('m-note-title')}</div>
          <div class="field"><label>Note or link ${requiredMark()}</label><textarea id="m-body" placeholder="Write it here, or paste a URL — links become clickable automatically">${escapeHtml(src ? src.body : '')}</textarea>${fieldError('m-body')}</div>
          <div class="field"><label>Tags (comma separated, optional)</label><input type="text" id="m-tags" value="${escapeAttr(src ? src.tagsStr : '')}" placeholder="e.g. gift ideas, recipes" /></div>
          ${existing && existing.createdAt ? `<div class="note-dates" style="margin-bottom:2px;">Created ${fmtFullDateTime(existing.createdAt)}</div><div class="note-dates" style="margin-bottom:12px;">Updated ${fmtFullDateTime(existing.updatedAt)}</div>` : ''}
          <div class="modal-actions">
            ${existing ? `<button class="btn ghost" data-delete-note-inmodal="${existing.id}" style="margin-right:auto; color:var(--clay); border-color:#EAD0C4;">Delete</button>` : ''}
            <button class="btn ghost" data-close-modal>Cancel</button>
            <button class="btn" data-save-note>${existing ? 'Save changes' : 'Save'}</button>
          </div>
        </div>
      </div>`;
    }
    if (modal === 'export') {
      const json = JSON.stringify(
        { events: state.events, tasks: state.tasks, notes: state.notes },
        null,
        2,
      );
      return `<div class="overlay" data-overlay>
        <div class="modal" style="width:440px;">
          <h3>Export your data</h3>
          <div class="field"><textarea readonly id="export-json" style="min-height:200px; font-family:'IBM Plex Mono',monospace; font-size:11px;">${escapeHtml(json)}</textarea></div>
          <div class="modal-actions">
            <button class="btn ghost" data-close-modal>Close</button>
            <button class="btn ghost" data-copy-export>Copy</button>
            <button class="btn" data-download-export>Download .json</button>
          </div>
        </div>
      </div>`;
    }
    if (modal && modal.startsWith('day:')) {
      const date = modal.split(':')[1];
      const dayEvents = state.events
        .filter((ev) => eventOccursOnDate(ev, date))
        .map((ev) => Object.assign({}, ev, { date }))
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      return `<div class="overlay" data-overlay>
        <div class="modal">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
            <h3 style="margin:0;">${fmtDay(date)}</h3>
            <button class="icon-btn" data-close-modal style="font-size:15px;">✕</button>
          </div>
          <div style="max-height:340px; overflow-y:auto;">
            ${dayEvents.length ? dayEvents.map((ev) => eventCard(ev)).join('') : `<div class="empty" style="padding:20px 0;">Nothing on this day yet.</div>`}
          </div>
          <div class="modal-actions" style="justify-content:flex-start; margin-top:14px;">
            <button class="btn" data-day-add-event="${date}">+ Add event</button>
          </div>
        </div>
      </div>`;
    }
    return '';
  }

  function escapeHtml(s) {
    return (s || '').replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }
  function requiredMark() {
    return `<span style="color:var(--clay);">*</span>`;
  }
  function fieldError(id) {
    return fieldErrors[id]
      ? `<div style="color:var(--clay); font-size:13px; margin-top:4px;">Required field</div>`
      : '';
  }

  // ---------- events ----------
  function bindEvents() {
    // querySelectorAll -- the button is rendered twice (once for desktop,
    // once duplicated into the mobile top bar), only one of which is
    // visible per breakpoint, but both need the click handler wired up.
    document.querySelectorAll('[data-auth-signout]').forEach((signOutBtn) => {
      // Deliberately doesn't set isLocalMode/authUser/call load() itself --
      // signOut() fires the onAuthStateChange listener in initAuth(), which
      // is the single source of truth for reacting to that. This button
      // only shows when a real session exists, which means supabaseClient
      // is guaranteed to be set.
      signOutBtn.onclick = async () => {
        authError = '';
        await supabaseClient.auth.signOut();
      };
    });

    // ---- sign in / sign up (guest -> account) ----
    const authSubmitBtn = document.querySelector('[data-auth-submit]');
    if (authSubmitBtn) {
      authSubmitBtn.onclick = async () => {
        const emailEl = document.getElementById('m-auth-email');
        const passwordEl = document.getElementById('m-auth-password');
        const email = emailEl ? emailEl.value.trim() : '';
        const password = passwordEl ? passwordEl.value : '';
        authEmail = email;
        authPassword = password;
        authError = '';
        authMessage = '';

        if (!supabaseClient) {
          authError = 'Supabase is not available.';
          render();
          return;
        }
        if (!email || !password) {
          authError = 'Please enter both your email and password.';
          render();
          return;
        }

        authFlowInProgress = true;
        try {
          if (authMode === 'signin') {
            const result = await supabaseClient.auth.signInWithPassword({
              email,
              password,
            });
            if (result.error) {
              authFlowInProgress = false;
              authError = result.error.message;
              render();
              return;
            }
            const user = result.data.user || result.data.session?.user;
            const hasGuestData =
              state.events.length > 0 ||
              state.tasks.length > 0 ||
              state.notes.length > 0;
            if (hasGuestData) {
              // Pause here -- .auth modal now shows the confirm-replace
              // step instead. authFlowInProgress stays true until that
              // step resolves (confirm or cancel), so the listener keeps
              // deferring to this flow throughout.
              guestDataPendingReplace = user;
              render();
            } else {
              authUser = user;
              isLocalMode = false;
              authPassword = '';
              modal = null;
              authFlowInProgress = false;
              load();
            }
          } else {
            const result = await supabaseClient.auth.signUp({
              email,
              password,
            });
            if (result.error) {
              authFlowInProgress = false;
              authError = result.error.message;
              render();
              return;
            }
            const session = result.data.session;
            if (!session) {
              // Email confirmation required -- nothing to migrate yet,
              // leave guest data untouched.
              authFlowInProgress = false;
              authMode = 'signin';
              authMessage =
                'Account created! Check your email to confirm, then sign in.';
              authPassword = '';
              render();
              return;
            }
            // Brand-new account, so there's no existing cloud data to
            // conflict with -- safe to auto-migrate the guest data.
            authUser = result.data.user || session.user;
            isLocalMode = false;
            authPassword = '';
            modal = null;
            await save();
            authFlowInProgress = false;
            render();
          }
        } catch (e) {
          authFlowInProgress = false;
          authError = 'Authentication failed.';
          render();
        }
      };
    }

    const authToggleModeBtn = document.querySelector('[data-auth-toggle-mode]');
    if (authToggleModeBtn) {
      authToggleModeBtn.onclick = () => {
        authMode = authMode === 'signin' ? 'signup' : 'signin';
        authError = '';
        authMessage = '';
        render();
      };
    }

    const authEmailInput = document.getElementById('m-auth-email');
    if (authEmailInput) {
      authEmailInput.oninput = (e) => {
        authEmail = e.target.value;
      };
    }
    const authPasswordInput = document.getElementById('m-auth-password');
    if (authPasswordInput) {
      authPasswordInput.oninput = (e) => {
        authPassword = e.target.value;
      };
    }

    const confirmReplaceBtn = document.querySelector(
      '[data-auth-confirm-replace]',
    );
    if (confirmReplaceBtn) {
      confirmReplaceBtn.onclick = () => {
        authUser = guestDataPendingReplace;
        guestDataPendingReplace = null;
        isLocalMode = false;
        modal = null;
        authFlowInProgress = false;
        load();
      };
    }
    const cancelReplaceBtn = document.querySelector(
      '[data-auth-cancel-replace]',
    );
    if (cancelReplaceBtn) {
      cancelReplaceBtn.onclick = async () => {
        // Undo the sign-in server-side too -- otherwise a later reload
        // would pick up the real session and load the account's data
        // anyway, without ever having asked.
        if (supabaseClient) await supabaseClient.auth.signOut();
        guestDataPendingReplace = null;
        authFlowInProgress = false;
        authError = '';
        authMessage = '';
        modal = null;
        render();
      };
    }

    document.querySelectorAll('[data-view]').forEach(
      (b) =>
        (b.onclick = () => {
          state.globalQuery = '';
          snapshotDraftFromModal();
          state.view = b.dataset.view;
          save();
          render();
        }),
    );
    document.querySelectorAll('[data-agenda-mode]').forEach(
      (b) =>
        (b.onclick = () => {
          state.agendaMode = b.dataset.agendaMode;
          render();
        }),
    );
    document.querySelectorAll('[data-month-nav]').forEach(
      (b) =>
        (b.onclick = () => {
          const dir = parseInt(b.dataset.monthNav, 10);
          state.calMonth += dir;
          if (state.calMonth < 0) {
            state.calMonth = 11;
            state.calYear--;
          }
          if (state.calMonth > 11) {
            state.calMonth = 0;
            state.calYear++;
          }
          render();
        }),
    );
    const todayBtn = document.querySelector('[data-month-today]');
    if (todayBtn)
      todayBtn.onclick = () => {
        const t = new Date();
        state.calYear = t.getFullYear();
        state.calMonth = t.getMonth();
        state.selectedDate = localDateStr(t);
        render();
      };
    document.querySelectorAll('[data-day]').forEach(
      (cell) =>
        (cell.onclick = () => {
          state.selectedDate = cell.dataset.day;
          modal = 'day:' + cell.dataset.day;
          render();
        }),
    );

    document.querySelectorAll('[data-toggle-dark]').forEach(
      (b) =>
        (b.onclick = () => {
          state.darkMode = !state.darkMode;
          save();
          render();
        }),
    );

    document.querySelectorAll('[data-open-modal]').forEach(
      (b) =>
        (b.onclick = () => {
          captureDraftFromForm();
          editingEventId = null;
          editingTaskId = null;
          editingNoteId = null;
          modalReturn = null;
          fieldErrors = {};
          modal = b.dataset.openModal;
          render();
        }),
    );
    // If the confirm-replace step gets dismissed via the generic overlay
    // click or close button rather than its own dedicated buttons, still
    // undo the sign-in server-side -- same reasoning as the dedicated
    // cancel button above.
    const abandonPendingReplace = () => {
      if (!guestDataPendingReplace) return;
      if (supabaseClient) supabaseClient.auth.signOut();
      guestDataPendingReplace = null;
      authFlowInProgress = false;
    };
    // Same idea as above -- if the re-export prompt gets dismissed via the
    // overlay/close button instead of its own buttons, still acknowledge
    // the mismatch (stop nagging) rather than leaving it half-resolved.
    const abandonPendingGcalReadd = () => {
      if (!reAddGcalEventId) return;
      const ev = state.events.find((e) => e.id === reAddGcalEventId);
      if (ev) ev.gcalAddedAt = { date: ev.date, time: ev.time || '' };
      reAddGcalEventId = null;
      save();
    };
    const overlay = document.querySelector('[data-overlay]');
    if (overlay)
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          abandonPendingReplace();
          abandonPendingGcalReadd();
          editingEventId = null;
          editingTaskId = null;
          editingNoteId = null;
          eventDraft = null;
          taskDraft = null;
          noteDraft = null;
          categoryDraft = null;
          fieldErrors = {};
          modal = modalReturn;
          modalReturn = null;
          render();
        }
      });
    document.querySelectorAll('[data-close-modal]').forEach(
      (b) =>
        (b.onclick = () => {
          abandonPendingReplace();
          abandonPendingGcalReadd();
          editingEventId = null;
          editingTaskId = null;
          editingNoteId = null;
          eventDraft = null;
          taskDraft = null;
          noteDraft = null;
          categoryDraft = null;
          fieldErrors = {};
          modal = modalReturn;
          modalReturn = null;
          render();
        }),
    );

    // Enter-to-save works in any of the add/edit modals (event, task, note,
    // category, auth) -- one generic handler instead of wiring each field
    // separately. Skipped inside a <textarea>, where Enter should insert a
    // newline.
    const modalEl = document.querySelector('.modal');
    if (modalEl) {
      modalEl.onkeydown = (e) => {
        if (e.key !== 'Enter' || e.target.tagName === 'TEXTAREA') return;
        const saveBtn = modalEl.querySelector(
          '[data-save-event], [data-save-task], [data-save-note], [data-save-category], [data-auth-submit]',
        );
        if (saveBtn) {
          e.preventDefault();
          saveBtn.click();
        }
      };

      modalEl.addEventListener('input', () => {
        snapshotDraftFromModal();
      });
      modalEl.addEventListener('change', () => {
        snapshotDraftFromModal();
      });
    }
    const mTitle = document.getElementById('m-title');
    if (mTitle) {
      mTitle.focus();
      const tl = mTitle.value.length;
      mTitle.setSelectionRange(tl, tl);
    }

    // ---- events ----
    const saveEventBtn = document.querySelector('[data-save-event]');
    if (saveEventBtn)
      saveEventBtn.onclick = () => {
        const title = document.getElementById('m-title').value.trim();
        const date = document.getElementById('m-date').value;
        const type = document.getElementById('m-type').value;
        const time = document.getElementById('m-time').value;
        const repeat = document.getElementById('m-repeat').value;

        fieldErrors = {};
        if (!title) fieldErrors['m-title'] = true;
        if (!date) fieldErrors['m-date'] = true;
        if (Object.keys(fieldErrors).length) {
          eventDraft = { title, type, date, time, repeat };
          render();
          return;
        }

        const data = { title, type, date, time, repeat };
        const wasEdit = !!editingEventId;
        let promptReexport = false;
        if (wasEdit) {
          const ev = state.events.find((e) => e.id === editingEventId);
          const prevExport = ev.gcalAddedAt;
          Object.assign(ev, data);
          if (
            prevExport &&
            (prevExport.date !== date || (prevExport.time || '') !== (time || ''))
          ) {
            promptReexport = true;
            reAddGcalEventId = ev.id;
          }
        } else {
          state.events.push({ id: uid(), ...data });
        }
        editingEventId = null;
        eventDraft = null;
        fieldErrors = {};
        if (promptReexport) {
          modal = 'readd-gcal';
        } else {
          modal = modalReturn;
          modalReturn = null;
        }
        save();
        render();
      };
    document.querySelectorAll('[data-delete-event-inmodal]').forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.deleteEventInmodal;
          const idx = state.events.findIndex((x) => x.id === id);
          if (idx === -1) return;
          state.events.splice(idx, 1);
          editingEventId = null;
          eventDraft = null;
          fieldErrors = {};
          modal = modalReturn;
          modalReturn = null;
          save();
          render();
        }),
    );
    document.querySelectorAll('[data-edit-event]').forEach(
      (b) =>
        (b.onclick = () => {
          editingEventId = b.dataset.editEvent;
          fieldErrors = {};
          modalReturn = modal && modal.startsWith('day:') ? modal : null;
          modal = 'event';
          render();
        }),
    );
    document.querySelectorAll('[data-day-add-event]').forEach(
      (b) =>
        (b.onclick = () => {
          state.selectedDate = b.dataset.dayAddEvent;
          editingEventId = null;
          fieldErrors = {};
          modalReturn = modal;
          modal = 'event';
          render();
        }),
    );
    document.querySelectorAll('[data-snooze-event]').forEach(
      (b) =>
        (b.onclick = () => {
          const ev = state.events.find((x) => x.id === b.dataset.snoozeEvent);
          if (!ev) return;
          if (ev.repeat && ev.repeat !== 'none') return; // guarded: button isn't shown for recurring events
          ev.date = addDays(ev.date, 1);
          save();
          render();
        }),
    );
    document.querySelectorAll('[data-del-event]').forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.delEvent;
          const idx = state.events.findIndex((x) => x.id === id);
          if (idx === -1) return;
          state.events.splice(idx, 1);
          save();
          render();
        }),
    );
    // The link itself does the navigating (href + target="_blank") -- this
    // just records that it was clicked, so a later date/time edit knows to
    // offer the re-add prompt.
    document.querySelectorAll('[data-gcal-link]').forEach(
      (a) =>
        (a.onclick = () => {
          const ev = state.events.find((e) => e.id === a.dataset.gcalLink);
          if (!ev) return;
          ev.gcalAddedAt = { date: ev.date, time: ev.time || '' };
          save();
        }),
    );
    const gcalReaddBtn = document.querySelector('[data-gcal-readd]');
    if (gcalReaddBtn)
      gcalReaddBtn.onclick = () => {
        const ev = state.events.find((e) => e.id === reAddGcalEventId);
        if (ev) {
          window.open(googleCalendarUrl(ev), '_blank', 'noopener');
          ev.gcalAddedAt = { date: ev.date, time: ev.time || '' };
        }
        reAddGcalEventId = null;
        modal = modalReturn;
        modalReturn = null;
        save();
        render();
      };
    const gcalDismissBtn = document.querySelector('[data-gcal-dismiss]');
    if (gcalDismissBtn)
      gcalDismissBtn.onclick = () => {
        const ev = state.events.find((e) => e.id === reAddGcalEventId);
        if (ev) {
          // Acknowledge and stop nagging about this same mismatch -- the
          // next prompt only fires if the date/time changes again from
          // here, even though Google Calendar itself wasn't updated.
          ev.gcalAddedAt = { date: ev.date, time: ev.time || '' };
        }
        reAddGcalEventId = null;
        modal = modalReturn;
        modalReturn = null;
        save();
        render();
      };

    // ---- tasks ----
    const saveTaskBtn = document.querySelector('[data-save-task]');
    if (saveTaskBtn)
      saveTaskBtn.onclick = () => {
        const text = document.getElementById('m-text').value.trim();
        const day = document.getElementById('m-day').value;
        const priority = document.getElementById('m-priority').value;
        const categorySel = document.getElementById('m-category').value;
        const newCategory = document.getElementById('m-new-category')
          ? document.getElementById('m-new-category').value.trim()
          : '';

        fieldErrors = {};
        if (!text) fieldErrors['m-text'] = true;
        if (categorySel === '__new__' && !newCategory)
          fieldErrors['m-new-category'] = true;
        if (Object.keys(fieldErrors).length) {
          taskDraft = {
            text,
            day,
            priority,
            category: categorySel,
            newCategory,
          };
          render();
          return;
        }

        let category = categorySel;
        if (categorySel === '__new__') {
          if (!state.taskCategories.includes(newCategory))
            state.taskCategories.push(newCategory);
          category = newCategory;
        }

        const data = { text, day, priority, category };
        const wasEdit = !!editingTaskId;
        if (wasEdit) {
          const t = state.tasks.find((x) => x.id === editingTaskId);
          Object.assign(t, data);
        } else {
          state.tasks.push({ id: uid(), ...data, done: false });
        }
        editingTaskId = null;
        taskDraft = null;
        fieldErrors = {};
        modal = null;
        save();
        render();
      };
    const saveCategoryBtn = document.querySelector('[data-save-category]');
    if (saveCategoryBtn)
      saveCategoryBtn.onclick = () => {
        const name = document.getElementById('m-category-name').value.trim();
        fieldErrors = {};
        if (!name || state.taskCategories.includes(name)) {
          fieldErrors['m-category-name'] = true;
          categoryDraft = name;
          render();
          return;
        }
        state.taskCategories.push(name);
        categoryDraft = null;
        fieldErrors = {};
        modal = null;
        save();
        render();
      };
    const categorySel = document.getElementById('m-category');
    if (categorySel)
      categorySel.onchange = () => {
        taskDraft = {
          text: document.getElementById('m-text').value,
          day: document.getElementById('m-day').value,
          priority: document.getElementById('m-priority').value,
          category: categorySel.value,
          newCategory: '',
        };
        render();
      };
    const mText = document.getElementById('m-text');
    if (mText) {
      mText.focus();
      const len = mText.value.length;
      mText.setSelectionRange(len, len);
    }
    const mCategoryName = document.getElementById('m-category-name');
    if (mCategoryName) {
      mCategoryName.focus();
      const len = mCategoryName.value.length;
      mCategoryName.setSelectionRange(len, len);
    }
    document.querySelectorAll('[data-delete-task-inmodal]').forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.deleteTaskInmodal;
          const idx = state.tasks.findIndex((x) => x.id === id);
          if (idx === -1) return;
          state.tasks.splice(idx, 1);
          editingTaskId = null;
          taskDraft = null;
          fieldErrors = {};
          modal = null;
          save();
          render();
        }),
    );
    document.querySelectorAll('[data-edit-task]').forEach(
      (b) =>
        (b.onclick = () => {
          editingTaskId = b.dataset.editTask;
          fieldErrors = {};
          modal = 'task';
          render();
        }),
    );
    document.querySelectorAll('[data-toggle-task]').forEach(
      (b) =>
        (b.onclick = () => {
          const t = state.tasks.find((x) => x.id === b.dataset.toggleTask);
          t.done = !t.done;
          save();
          render();
        }),
    );
    document.querySelectorAll('[data-del-task]').forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.delTask;
          const idx = state.tasks.findIndex((x) => x.id === id);
          if (idx === -1) return;
          state.tasks.splice(idx, 1);
          save();
          render();
        }),
    );

    // ---- To Do category board management ----
    document.querySelectorAll('[data-add-to-category]').forEach(
      (b) =>
        (b.onclick = () => {
          editingTaskId = null;
          taskDraft = {
            text: '',
            day: '',
            priority: 'med',
            category: b.dataset.addToCategory,
            newCategory: '',
          };
          fieldErrors = {};
          modal = 'task';
          render();
        }),
    );
    document.querySelectorAll('[data-edit-category]').forEach(
      (b) =>
        (b.onclick = () => {
          editingCategoryName = b.dataset.editCategory;
          fieldErrors = {};
          render();
        }),
    );
    document.querySelectorAll('[data-cancel-category-rename]').forEach(
      (b) =>
        (b.onclick = () => {
          editingCategoryName = null;
          fieldErrors = {};
          render();
        }),
    );
    document.querySelectorAll('[data-save-category-rename]').forEach(
      (b) =>
        (b.onclick = () => {
          const oldName = b.dataset.saveCategoryRename;
          const input = document.getElementById('cat-rename-input');
          const newName = input ? input.value.trim() : '';
          fieldErrors = {};
          const duplicate =
            newName !== oldName && state.taskCategories.includes(newName);
          if (!newName || duplicate) {
            fieldErrors['cat-rename-input'] = true;
            render();
            return;
          }
          const i = state.taskCategories.indexOf(oldName);
          if (i !== -1) state.taskCategories[i] = newName;
          state.tasks.forEach((t) => {
            if (t.category === oldName) t.category = newName;
          });
          editingCategoryName = null;
          save();
          render();
        }),
    );
    document.querySelectorAll('[data-delete-category]').forEach(
      (b) =>
        (b.onclick = () => {
          const catName = b.dataset.deleteCategory;
          state.taskCategories = state.taskCategories.filter(
            (c) => c !== catName,
          );
          state.tasks = state.tasks.filter((t) => t.category !== catName);
          if (editingCategoryName === catName) editingCategoryName = null;
          save();
          render();
        }),
    );
    const catRenameInput = document.getElementById('cat-rename-input');
    if (catRenameInput) {
      catRenameInput.focus();
      catRenameInput.select();
      catRenameInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const saveBtn = document.querySelector('[data-save-category-rename]');
          if (saveBtn) saveBtn.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          const cancelBtn = document.querySelector(
            '[data-cancel-category-rename]',
          );
          if (cancelBtn) cancelBtn.click();
        }
      };
    }

    // ---- notes ----
    const categorySelNote = document.getElementById('m-category');
    if (categorySelNote)
      categorySelNote.onchange = () => {
        noteDraft = {
          category: categorySelNote.value,
          title: document.getElementById('m-note-title').value,
          body: document.getElementById('m-body').value,
          tagsStr: document.getElementById('m-tags').value,
          newCategory: '',
        };
        render();
      };
    const saveNoteBtn = document.querySelector('[data-save-note]');
    const mNoteTitle = document.getElementById('m-note-title');
    if (mNoteTitle) {
      mNoteTitle.focus();
      const ntl = mNoteTitle.value.length;
      mNoteTitle.setSelectionRange(ntl, ntl);
    }
    if (saveNoteBtn)
      saveNoteBtn.onclick = () => {
        let title = document.getElementById('m-note-title').value.trim();
        const body = document.getElementById('m-body').value.trim();
        const categorySel = document.getElementById('m-category').value;
        const newCategory = document.getElementById('m-new-category')
          ? document.getElementById('m-new-category').value.trim()
          : '';
        const tagsStr = document.getElementById('m-tags').value;
        const tags = tagsStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const bodyIsUrl = isUrl(body);

        fieldErrors = {};
        if (!body) fieldErrors['m-body'] = true;
        if (!title && !bodyIsUrl) fieldErrors['m-note-title'] = true;
        if (categorySel === '__new__' && !newCategory)
          fieldErrors['m-new-category'] = true;
        if (Object.keys(fieldErrors).length) {
          noteDraft = {
            category: categorySel,
            title: document.getElementById('m-note-title').value,
            body,
            tagsStr,
            newCategory,
          };
          render();
          return;
        }
        if (!title && bodyIsUrl) {
          try {
            title = new URL(body).hostname.replace('www.', '');
          } catch (e) {
            title = body;
          }
        }

        let category = categorySel;
        if (categorySel === '__new__') {
          if (!state.noteCategories.includes(newCategory))
            state.noteCategories.push(newCategory);
          category = newCategory;
        }

        const now = new Date().toISOString();
        const wasEdit = !!editingNoteId;
        if (wasEdit) {
          const n = state.notes.find((x) => x.id === editingNoteId);
          Object.assign(n, { category, title, body, tags, updatedAt: now });
          if (!n.createdAt) n.createdAt = now;
        } else {
          state.notes.push({
            id: uid(),
            category,
            title,
            body,
            tags,
            createdAt: now,
            updatedAt: now,
          });
        }
        editingNoteId = null;
        noteDraft = null;
        fieldErrors = {};
        modal = null;
        save();
        render();
      };
    document.querySelectorAll('[data-edit-note]').forEach(
      (b) =>
        (b.onclick = () => {
          editingNoteId = b.dataset.editNote;
          fieldErrors = {};
          modal = 'note';
          render();
        }),
    );
    document.querySelectorAll('[data-delete-note-inmodal]').forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.deleteNoteInmodal;
          const idx = state.notes.findIndex((x) => x.id === id);
          if (idx === -1) return;
          state.notes.splice(idx, 1);
          editingNoteId = null;
          modal = null;
          save();
          render();
        }),
    );
    document.querySelectorAll('[data-del-note]').forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.delNote;
          const idx = state.notes.findIndex((x) => x.id === id);
          if (idx === -1) return;
          state.notes.splice(idx, 1);
          save();
          render();
        }),
    );
    document.querySelectorAll('[data-tag-filter]').forEach(
      (b) =>
        (b.onclick = () => {
          state.noteTagFilter = b.dataset.tagFilter || null;
          render();
        }),
    );
    document.querySelectorAll('[data-category-filter]').forEach(
      (b) =>
        (b.onclick = () => {
          state.noteCategoryFilter = b.dataset.categoryFilter || null;
          render();
        }),
    );

    // ---- exports ----
    const copyBtn = document.querySelector('[data-copy-export]');
    if (copyBtn)
      copyBtn.onclick = () => {
        const ta = document.getElementById('export-json');
        ta.select();
        // Direct DOM tweak, not a full render() -- this must not touch the
        // rest of the app or it could interrupt something else in progress.
        const original = copyBtn.textContent;
        try {
          document.execCommand('copy');
          copyBtn.textContent = 'Copied!';
        } catch (e) {
          copyBtn.textContent = 'Select & copy manually';
        }
        setTimeout(() => {
          copyBtn.textContent = original;
        }, 1600);
      };
    const dlBtn = document.querySelector('[data-download-export]');
    if (dlBtn)
      dlBtn.onclick = () => {
        try {
          const blob = new Blob(
            [document.getElementById('export-json').value],
            { type: 'application/json' },
          );
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'planner-export.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (e) {
          /* blocked -- Copy button above still works */
        }
      };

    // ---- searches ----
    const search = document.querySelector('[data-search]');
    if (search) {
      search.oninput = () => {
        state.searchQuery = search.value;
        const caret = search.selectionStart;
        render();
        const fresh = document.querySelector('[data-search]');
        if (fresh) {
          fresh.focus();
          fresh.selectionStart = fresh.selectionEnd = caret;
        }
      };
    }
    const gsearch = document.querySelector('[data-global-search]');
    if (gsearch) {
      gsearch.oninput = () => {
        state.globalQuery = gsearch.value;
        const caret = gsearch.selectionStart;
        render();
        const fresh = document.querySelector('[data-global-search]');
        if (fresh) {
          fresh.focus();
          fresh.selectionStart = fresh.selectionEnd = caret;
        }
      };
    }
    document.querySelectorAll('[data-clear-search]').forEach(
      (b) =>
        (b.onclick = () => {
          state.globalQuery = '';
          render();
        }),
    );
    document.querySelectorAll('[data-goto-event-date]').forEach(
      (b) =>
        (b.onclick = () => {
          state.globalQuery = '';
          state.view = 'agenda';
          state.selectedDate = b.dataset.gotoEventDate;
          const d = new Date(b.dataset.gotoEventDate + 'T00:00:00');
          state.calYear = d.getFullYear();
          state.calMonth = d.getMonth();
          render();
        }),
    );
    document.querySelectorAll('[data-goto-week]').forEach(
      (b) =>
        (b.onclick = () => {
          state.globalQuery = '';
          state.view = 'week';
          render();
        }),
    );
    document.querySelectorAll('[data-goto-notes]').forEach(
      (b) =>
        (b.onclick = () => {
          state.globalQuery = '';
          state.view = 'notes';
          render();
        }),
    );
  }

  initAuth();
  loadJokeOfTheDay();
})();

// Register service worker for offline / installable support (Add to Home Screen)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
