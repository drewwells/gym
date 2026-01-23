// DOM Elements
const loginContainer = document.getElementById('loginContainer');
const scheduleContainer = document.getElementById('scheduleContainer');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const scheduleGrid = document.getElementById('scheduleGrid');
const loadingIndicator = document.getElementById('loadingIndicator');
const currentDateEl = document.getElementById('currentDate');
const refreshBtn = document.getElementById('refreshBtn');
const prevDayBtn = document.getElementById('prevDayBtn');
const todayBtn = document.getElementById('todayBtn');
const nextDayBtn = document.getElementById('nextDayBtn');

// Constants
const STUDIO_MIND_BODY = 'Mind-Body Studio';
const STUDIO_GROUP_EXERCISE = 'Group Exercise Studio';
const GYM_HOURS = generateHourlySlots(6, 18); // 6 AM to 6 PM

// State
let currentViewDate = new Date();

// Initialize
init();

async function init() {
  // Set up event listeners
  loginForm.addEventListener('submit', handleLogin);
  refreshBtn.addEventListener('click', () => loadSchedule());
  prevDayBtn.addEventListener('click', () => changeDate(-1));
  todayBtn.addEventListener('click', () => { currentViewDate = new Date(); loadSchedule(); });
  nextDayBtn.addEventListener('click', () => changeDate(1));

  // Check if we have a valid session
  await checkSession();
}

// Check if user has valid session
async function checkSession() {
  try {
    const response = await fetch('/api/session');

    if (response.ok) {
      const data = await response.json();
      if (data.authenticated) {
        // Valid session, show schedule
        loginContainer.style.display = 'none';
        scheduleContainer.style.display = 'block';
        loadSchedule();
        return;
      }
    }

    // No valid session, show login
    loginContainer.style.display = 'block';
    scheduleContainer.style.display = 'none';
  } catch (error) {
    console.error('Session check error:', error);
    // Show login on error
    loginContainer.style.display = 'block';
    scheduleContainer.style.display = 'none';
  }
}

function changeDate(days) {
  currentViewDate.setDate(currentViewDate.getDate() + days);
  loadSchedule();
}

// Generate hourly time slots (e.g., 6 AM to 6 PM)
function generateHourlySlots(startHour, endHour) {
  const slots = [];
  for (let hour = startHour; hour <= endHour; hour++) {
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
    slots.push(`${displayHour}:00 ${ampm}`);
  }
  return slots;
}

// Handle login form submission
async function handleLogin(e) {
  e.preventDefault();
  loginError.textContent = '';

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (response.ok) {
      // Login successful, load schedule
      loginContainer.style.display = 'none';
      scheduleContainer.style.display = 'block';
      loadSchedule();
    } else {
      const error = await response.json();
      loginError.textContent = error.error || 'Login failed. Please check your credentials.';
    }
  } catch (error) {
    loginError.textContent = 'Network error. Please try again.';
    console.error('Login error:', error);
  }
}

// Load schedule from API
async function loadSchedule() {
  loadingIndicator.style.display = 'block';
  scheduleGrid.innerHTML = '';

  // Update date display
  const isToday = isSameDay(currentViewDate, new Date());
  currentDateEl.textContent = currentViewDate.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }) + (isToday ? ' (Today)' : '');

  try {
    const dateStr = currentViewDate.toISOString().split('T')[0];
    const response = await fetch(`/api/schedule?date=${dateStr}`);

    if (response.status === 401) {
      // Session expired, show login and prompt user
      loginContainer.style.display = 'block';
      scheduleContainer.style.display = 'none';
      loginError.textContent = 'Your session has expired. Please log in again.';
      return;
    }

    if (!response.ok) {
      throw new Error('Failed to load schedule');
    }

    const data = await response.json();
    renderSchedule(data.gxp_classes || [], isToday);

  } catch (error) {
    scheduleGrid.innerHTML = `<div class="error-message">Failed to load schedule. ${error.message}</div>`;
    console.error('Schedule load error:', error);
  } finally {
    loadingIndicator.style.display = 'none';
  }
}

function isSameDay(date1, date2) {
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth() === date2.getMonth() &&
         date1.getDate() === date2.getDate();
}

// Parse Microsoft JSON date format: /Date(1769173200000)/
function parseMSDate(msDateString) {
  const match = msDateString.match(/\/Date\((\d+)\)\//);
  if (match) {
    return new Date(parseInt(match[1]));
  }
  return null;
}

// Format time to "H:00 AM/PM"
function formatTime(date) {
  const hour = date.getHours();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
  return `${displayHour}:00 ${ampm}`;
}

// Check if a class occupies a given time slot
function classOccupiesSlot(classObj, timeSlot) {
  const startDate = parseMSDate(classObj.start_date_time);
  const endDate = parseMSDate(classObj.end_date_time);

  if (!startDate || !endDate) return false;

  const classStartTime = formatTime(startDate);
  return classStartTime === timeSlot;
}

// Render the schedule grid
function renderSchedule(classes, isToday) {
  // Build availability data structure
  const availability = {};

  GYM_HOURS.forEach(timeSlot => {
    availability[timeSlot] = {
      [STUDIO_MIND_BODY]: { available: true, class: null },
      [STUDIO_GROUP_EXERCISE]: { available: true, class: null }
    };
  });

  // Mark time slots as booked
  classes.forEach(classObj => {
    const studio = classObj.area_name;

    GYM_HOURS.forEach(timeSlot => {
      if (classOccupiesSlot(classObj, timeSlot)) {
        if (availability[timeSlot][studio]) {
          availability[timeSlot][studio].available = false;
          availability[timeSlot][studio].class = classObj;
        }
      }
    });
  });

  // Filter out past hours if viewing today
  const now = new Date();
  const currentHour = now.getHours();
  const hoursToShow = isToday
    ? GYM_HOURS.filter(timeSlot => {
        const hour = parseTimeSlot(timeSlot);
        return hour >= currentHour;
      })
    : GYM_HOURS;

  // Render grid
  let html = '<div class="grid-header">';
  html += '<div class="grid-cell header-cell">Time</div>';
  html += `<div class="grid-cell header-cell">${STUDIO_MIND_BODY}</div>`;
  html += `<div class="grid-cell header-cell">${STUDIO_GROUP_EXERCISE}</div>`;
  html += '</div>';

  hoursToShow.forEach(timeSlot => {
    html += '<div class="grid-row">';
    html += `<div class="grid-cell time-cell">${timeSlot}</div>`;

    // Mind-Body Studio
    const mindBodySlot = availability[timeSlot][STUDIO_MIND_BODY];
    html += renderSlot(mindBodySlot);

    // Group Exercise Studio
    const groupExSlot = availability[timeSlot][STUDIO_GROUP_EXERCISE];
    html += renderSlot(groupExSlot);

    html += '</div>';
  });

  scheduleGrid.innerHTML = html;
}

// Parse time slot string to hour (24-hour format)
function parseTimeSlot(timeSlot) {
  const match = timeSlot.match(/(\d+):00 (AM|PM)/);
  if (!match) return 0;

  let hour = parseInt(match[1]);
  const ampm = match[2];

  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  return hour;
}

// Render individual slot
function renderSlot(slot) {
  if (slot.available) {
    return '<div class="grid-cell slot-available"><span class="availability-badge">✓ Available</span></div>';
  } else {
    const classObj = slot.class;
    const isFull = classObj.is_class_full;
    const fullClass = isFull ? ' slot-full' : '';

    return `
      <div class="grid-cell slot-booked${fullClass}">
        <div class="class-name">${classObj.name}</div>
        <div class="class-instructor">${classObj.instructor_name}</div>
        <div class="class-capacity">${classObj.booked}/${classObj.capacity} booked</div>
      </div>
    `;
  }
}
