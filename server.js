const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SESSION_FILE = path.join(__dirname, '.session.json');

// In-memory session store (sessionToken -> cookies mapping)
const sessionStore = new Map();

// Middleware
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Helper: Generate secure session token
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Helper: Load session from in-memory store
function loadSession(sessionToken) {
  if (!sessionToken) return null;

  const session = sessionStore.get(sessionToken);
  if (!session) return null;

  // Check if session is older than 6 months
  const sessionAge = Date.now() - session.timestamp;
  const maxAge = 6 * 30 * 24 * 60 * 60 * 1000; // 6 months (approximately)

  if (sessionAge > maxAge) {
    console.log('Session expired (older than 6 months)');
    sessionStore.delete(sessionToken);
    return null;
  }

  return session;
}

// Helper: Save session to in-memory store
function saveSession(sessionToken, cookies) {
  sessionStore.set(sessionToken, {
    cookies,
    timestamp: Date.now()
  });
  console.log('Session saved successfully');
}

// Helper: Load sessions from disk on startup
function loadSessionsFromDisk() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, 'utf8');
      const sessions = JSON.parse(data);

      // Load all sessions into memory
      Object.entries(sessions).forEach(([token, session]) => {
        sessionStore.set(token, session);
      });

      console.log(`Loaded ${sessionStore.size} sessions from disk`);
    }
  } catch (error) {
    console.error('Error loading sessions from disk:', error);
  }
}

// Helper: Save sessions to disk periodically
function saveSessionsToDisk() {
  try {
    const sessions = {};
    sessionStore.forEach((session, token) => {
      sessions[token] = session;
    });

    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
    console.log('Sessions persisted to disk');
  } catch (error) {
    console.error('Error saving sessions to disk:', error);
  }
}

// Load sessions on startup
loadSessionsFromDisk();

// Save sessions to disk every 5 minutes
setInterval(saveSessionsToDisk, 5 * 60 * 1000);

// Helper: Extract cookies from response headers
function extractCookies(headers) {
  const setCookieHeaders = headers['set-cookie'] || [];
  const cookies = {};

  setCookieHeaders.forEach(cookieStr => {
    const match = cookieStr.match(/^([^=]+)=([^;]+)/);
    if (match) {
      cookies[match[1]] = match[2];
    }
  });

  return cookies;
}

// Helper: Build cookie string from object
function buildCookieString(cookies) {
  return Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');
}

// GET /api/session - Check if session is valid
app.get('/api/session', async (req, res) => {
  const sessionToken = req.headers['x-session-token'] || req.cookies?.sessionToken;

  const session = loadSession(sessionToken);

  if (!session || !session.cookies) {
    return res.status(401).json({ authenticated: false });
  }

  res.json({
    authenticated: true,
    sessionAge: Date.now() - session.timestamp,
    timestamp: session.timestamp
  });
});

// POST /api/login - Authenticate with Daxko
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    console.log('Attempting login for:', username);

    // Step 1: Build initial cookies (these are required by Daxko)
    const now = Math.floor(Date.now() / 1000);
    const initialCookies = {
      '__utma': `1.${Math.floor(Math.random() * 1000000000)}.${now}.${now}.${now}.1`,
      '__utmb': `1.3.10.${now}`,
      '__utmc': '1',
      '__utmz': `1.${now}.1.1.utmcsr=(direct)|utmccn=(direct)|utmcmd=(none)`,
      '__utmt': '1',
      '__oauth_admin': ''
    };

    console.log('Generated tracking cookies');

    // Step 2: GET find_account page to get __RequestVerificationToken cookie
    // We need to follow redirects manually and collect cookies at each step
    const findAccountUrl = 'https://operations.daxko.com/online/5198/Security/login.mvc/find_account?return_url=%2fonline%2f5198%2fRedirect%2fHomepage.mvc';

    console.log('\n=== STEP 1: GET FIND_ACCOUNT PAGE (for token cookie) ===');
    console.log('URL:', findAccountUrl);
    console.log('Cookies:', buildCookieString(initialCookies));

    // Make multiple requests, following redirects manually and collecting cookies
    let currentUrl = findAccountUrl;
    let findAccountResponse;

    for (let i = 0; i < 3; i++) {
      console.log(`\nRedirect attempt ${i + 1}:`);
      console.log('Requesting:', currentUrl);

      try {
        const response = await axios.get(currentUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Cookie': buildCookieString(initialCookies)
          },
          maxRedirects: 0,
          validateStatus: (status) => status >= 200 && status < 400
        });

        // If we get here, we got a 200 response
        console.log('Got 200 response!');
        findAccountResponse = response;

        // Extract cookies from successful response
        const responseCookies = extractCookies(response.headers);
        Object.assign(initialCookies, responseCookies);
        console.log('Cookies received:', Object.keys(responseCookies));
        break;
      } catch (error) {
        if (error.response && error.response.status === 302) {
          console.log('Got 302 redirect');

          // Extract cookies from this redirect
          const redirectCookies = extractCookies(error.response.headers);
          Object.assign(initialCookies, redirectCookies);
          console.log('Cookies received:', Object.keys(redirectCookies));

          // Get redirect location
          const location = error.response.headers.location;
          console.log('Redirect to:', location);

          // If relative URL, make it absolute
          if (location.startsWith('/')) {
            currentUrl = 'https://operations.daxko.com' + location;
          } else if (location.startsWith('http')) {
            currentUrl = location;
          } else {
            currentUrl = findAccountUrl; // Same URL, try again with new cookies
          }
        } else {
          throw error;
        }
      }
    }

    console.log('\nFinal response status:', findAccountResponse.status);
    console.log('All cookies now:', Object.keys(initialCookies));

    // Step 3: Go to login page with username to get CSRF token for login form
    const loginPageUrl = `https://operations.daxko.com/online/5198/Security/login.mvc/log_in?user_name=${encodeURIComponent(username)}&return_url=%2fonline%2f5198%2fRedirect%2fHomepage.mvc&oauth=`;

    console.log('\n=== STEP 2: GET LOGIN PAGE ===');
    console.log('URL:', loginPageUrl);
    console.log('Cookies:', buildCookieString(initialCookies));

    const loginPageResponse = await axios.get(loginPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': buildCookieString(initialCookies)
      },
      maxRedirects: 5
    });

    console.log('Response status:', loginPageResponse.status);

    // Extract cookies from login page
    const loginPageCookies = extractCookies(loginPageResponse.headers);
    Object.assign(initialCookies, loginPageCookies);
    console.log('Cookies after login page:', Object.keys(loginPageCookies));
    console.log('All cookies now:', Object.keys(initialCookies));

    // Extract CSRF token from login page
    let csrfToken = '';
    if (loginPageResponse.data) {
      const html = loginPageResponse.data;
      const csrfMatch = html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/);
      csrfToken = csrfMatch ? csrfMatch[1] : '';
      console.log('CSRF token for login extracted:', csrfToken ? 'Yes' : 'No');
    }

    // Step 2: Submit login form
    const loginData = new URLSearchParams({
      '__RequestVerificationToken': csrfToken,
      'user_name': username,
      'password': password,
      'keep_me_logged_in': 'false',
      'return_url': '/online/5198/Redirect/Homepage.mvc',
      'barcode': '',
      'oauth': ''
    });

    console.log('\n=== STEP 3: POST LOGIN ===');
    console.log('URL:', 'https://operations.daxko.com/online/5198/Security/login.mvc/log_in');
    console.log('Cookies being sent:', buildCookieString(initialCookies));
    console.log('CSRF token:', csrfToken);
    console.log('POST data (without password):', loginData.toString().replace(/password=[^&]*/, 'password=***'));

    let loginResponse;
    try {
      loginResponse = await axios.post(
        'https://operations.daxko.com/online/5198/Security/login.mvc/log_in',
        loginData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Cookie': buildCookieString(initialCookies),
            'Referer': loginPageUrl
          },
          maxRedirects: 0,
          validateStatus: (status) => status >= 200 && status < 400
        }
      );
    } catch (error) {
      // If it's a redirect error, that's actually OK - we just need the cookies
      if (error.response && error.response.status === 302) {
        console.log('Got 302 redirect (expected)');
        loginResponse = error.response;
      } else {
        console.log('Login POST error:', error.message);
        if (error.response) {
          console.log('Response status:', error.response.status);
          console.log('Response headers:', error.response.headers);
        }
        throw error;
      }
    }

    // Extract auth cookie from login response
    console.log('Login response status:', loginResponse.status);
    const authCookies = extractCookies(loginResponse.headers);
    console.log('Auth cookies received:', Object.keys(authCookies));
    console.log('All response headers:', loginResponse.headers);

    // Combine all cookies
    const allCookies = { ...initialCookies, ...authCookies };

    // Check if we got the auth cookie
    if (allCookies['.online_auth']) {
      // Generate session token
      const sessionToken = generateSessionToken();
      saveSession(sessionToken, allCookies);

      console.log('Login successful!');

      // Set cookie with 6-month expiration
      const sixMonths = 6 * 30 * 24 * 60 * 60 * 1000;
      res.cookie('sessionToken', sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: sixMonths,
        sameSite: 'lax'
      });

      res.json({ success: true, message: 'Login successful', sessionToken });
    } else {
      console.log('Login failed - no auth cookie received');
      res.status(401).json({ error: 'Login failed - invalid credentials' });
    }

  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Login failed', details: error.message });
  }
});

// Helper: Fetch and parse class schedule page for mappings
async function fetchScheduleMappings(cookies) {
  try {
    console.log('\n=== FETCHING SCHEDULE PAGE FOR MAPPINGS ===');
    const response = await axios.get('https://operations.daxko.com/Online/5198/GXP/ClassSchedule.mvc', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Cookie': buildCookieString(cookies)
      }
    });

    const html = response.data;

    // Extract the props object from the script tag
    const propsMatch = html.match(/var props = ({[\s\S]*?});[\s\S]*?props\.controller_url/);

    if (!propsMatch) {
      console.error('Could not find props object in HTML');
      return null;
    }

    const propsJson = propsMatch[1];
    const props = JSON.parse(propsJson);

    console.log('Extracted mappings:');
    console.log('- Instructors:', props.instructors.length);
    console.log('- Areas:', props.areas.length);
    console.log('- Branches:', props.branches.length);

    return {
      instructors: props.instructors,
      areas: props.areas,
      branches: props.branches,
      gxp_account_id: props.gxp_account_id
    };
  } catch (error) {
    console.error('Error fetching schedule mappings:', error.message);
    return null;
  }
}

// GET /api/schedule - Fetch schedule for a given date
app.get('/api/schedule', async (req, res) => {
  const sessionToken = req.headers['x-session-token'] || req.cookies?.sessionToken;

  const session = loadSession(sessionToken);

  if (!session || !session.cookies) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }

  try {
    // Get date from query parameter or use today
    const date = req.query.date || new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Fetch the mappings from the schedule page
    const mappings = await fetchScheduleMappings(session.cookies);

    if (!mappings) {
      return res.status(500).json({ error: 'Failed to fetch schedule mappings' });
    }

    // Build the mapped arrays
    const allMappedAreas = mappings.areas.map(area => ({
      gxp_studio_id: area.gxp_studio_id,
      area_id: area.area_id,
      area_name: area.area_name
    }));

    const allMappedInstructor = mappings.instructors.map(instructor => ({
      gxp_instructor_id: instructor.gxp_instructor_id,
      admin_id: instructor.admin_id,
      first_name: instructor.first_name,
      last_name: instructor.last_name,
      admin_name: instructor.admin_name
    }));

    const requestBody = {
      "all_mapped_areas": allMappedAreas,
      "all_mapped_instructor": allMappedInstructor,
      "all_mapped_branches": mappings.branches,
      "filters": {
        "date": date,
        "gxp_location_id": 6469,
        "gxp_instructor_ids": [],
        "gxp_studio_ids": [],
        "gxp_class_name_ids": [],
        "gxp_category_ids": []
      },
      "gxp_account_id": mappings.gxp_account_id,
      "any_exerciser_id_of_unit": 6093357,
      "page": 1
    };

    const response = await axios.post(
      'https://operations.daxko.com/online/5198/GXP/ClassSchedule.mvc/get_gxp_classes',
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0',
          'Cookie': buildCookieString(session.cookies),
          'Accept': 'application/json, text/plain, */*'
        }
      }
    );

    res.json(response.data);

  } catch (error) {
    console.error('Schedule fetch error:', error.message);

    // If unauthorized, clear session
    if (error.response && error.response.status === 401) {
      if (fs.existsSync(SESSION_FILE)) {
        fs.unlinkSync(SESSION_FILE);
      }
      res.status(401).json({ error: 'Session expired. Please log in again.' });
    } else {
      res.status(500).json({ error: 'Failed to fetch schedule', details: error.message });
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`JCC Studio Availability server running at http://localhost:${PORT}`);
  console.log('Visit the URL above to view studio availability');
});
