const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SESSION_FILE = path.join(__dirname, '.session.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Helper: Load session from file
function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, 'utf8');
      const session = JSON.parse(data);

      // Check if session is older than 7 days
      const sessionAge = Date.now() - session.timestamp;
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

      if (sessionAge > maxAge) {
        console.log('Session expired (older than 7 days)');
        fs.unlinkSync(SESSION_FILE);
        return null;
      }

      return session;
    }
  } catch (error) {
    console.error('Error loading session:', error);
  }
  return null;
}

// Helper: Save session to file
function saveSession(cookies) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookies, timestamp: Date.now() }, null, 2));
    console.log('Session saved successfully');
  } catch (error) {
    console.error('Error saving session:', error);
  }
}

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
  const session = loadSession();

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
      saveSession(allCookies);
      console.log('Login successful!');
      res.json({ success: true, message: 'Login successful' });
    } else {
      console.log('Login failed - no auth cookie received');
      res.status(401).json({ error: 'Login failed - invalid credentials' });
    }

  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Login failed', details: error.message });
  }
});

// GET /api/schedule - Fetch schedule for a given date
app.get('/api/schedule', async (req, res) => {
  const session = loadSession();

  if (!session || !session.cookies) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }

  try {
    // Get date from query parameter or use today
    const date = req.query.date || new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Load the complete mappings from the working request
    const fs = require('fs');
    const allMappedAreas = JSON.parse(fs.readFileSync('/tmp/all_mapped_areas.json', 'utf8'));
    const allMappedInstructor = JSON.parse(fs.readFileSync('/tmp/all_mapped_instructor.json', 'utf8'));

    const requestBody = {
      "all_mapped_areas": allMappedAreas,
      "all_mapped_instructor": allMappedInstructor,
      "all_mapped_branches": [
        {"gxp_location_id": 6469, "branch_id": 581, "branch_name": "Dell Jewish Community Center"}
      ],
      "filters": {
        "date": date,
        "gxp_location_id": 6469,
        "gxp_instructor_ids": [],
        "gxp_studio_ids": [],
        "gxp_class_name_ids": [],
        "gxp_category_ids": []
      },
      "gxp_account_id": 1020,
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
