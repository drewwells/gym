# Studio Availability Mashup

A clean, optimized web application that shows when the Mind-Body Studio and Group Exercise Studio are available.

## Features

- **Easy Login**: Simple username/password authentication with session caching
- **Real-time Data**: Fetches live schedule data from Daxko API
- **Availability Focus**: Highlights when studios are FREE with prominent visual indicators
- **Context Information**: Shows class names when studios are booked
- **Responsive Design**: Works seamlessly on desktop and mobile devices
- **Auto-refresh**: Manual refresh button to get latest schedule

## Studio Coverage

- **Mind-Body Studio** - Perfect for yoga, pilates, meditation
- **Group Exercise Studio** - Great for cardio, strength training, dance classes

## Installation

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the server**:
   ```bash
   npm start
   ```

3. **Open your browser**:
   Navigate to [http://localhost:3000](http://localhost:3000)

## Usage

1. **Login**: Enter your Dell JCC account credentials (same as the Daxko online portal)
2. **View Availability**: The grid shows hourly time slots from 6 AM to 6 PM
   - **Green slots** = Studio is AVAILABLE for use
   - **Gray slots** = Studio is booked with a class
3. **Refresh**: Click the refresh button to get the latest schedule

## How It Works

### Authentication
- Your credentials are sent securely to the Daxko API
- Session cookies are cached locally in `.session.json`
- You won't need to re-login until the session expires

### Schedule Display
- Fetches today's class schedule from Daxko
- Generates hourly time slots (6 AM - 6 PM)
- Compares scheduled classes against time slots
- Highlights available (free) time slots in green
- Shows class info for booked slots

### Data Privacy
- Credentials are only stored locally on your machine
- Session file (`.session.json`) is gitignored
- No data is sent to any third-party services

## Project Structure

```
jcc-mashup/
├── server.js              # Express backend (login & API proxy)
├── package.json           # Node.js dependencies
├── .gitignore            # Ignore session files
├── README.md             # This file
└── public/               # Frontend files
    ├── index.html        # Main HTML structure
    ├── app.js            # Frontend JavaScript
    └── styles.css        # Responsive CSS styling
```

## Technical Details

### Backend (Node.js + Express)
- **POST /api/login** - Authenticates with Daxko, caches session
- **GET /api/schedule** - Fetches today's schedule with cached credentials

### Daxko API Integration
- **Login endpoint**: `https://operations.daxko.com/online/5198/Security/login.mvc/log_in`
- **Schedule endpoint**: `https://operations.daxko.com/online/5198/GXP/ClassSchedule.mvc/get_gxp_classes`
- **Studio IDs**:
  - Mind-Body Studio: 32539
  - Group Exercise Studio: 32538

### Frontend (Vanilla JavaScript)
- No frameworks required - pure HTML/CSS/JS
- Responsive grid layout using CSS Grid
- Handles authentication state automatically

## Troubleshooting

### Login fails
- Check your credentials (same as Daxko online portal)
- Ensure you have an active Dell JCC membership
- Try logging into the official Daxko site first to verify credentials

### Schedule not loading
- Click the refresh button
- Check browser console for errors
- Session may have expired - try logging in again

### Mobile view issues
- Ensure viewport is set correctly (it is by default)
- Try refreshing the page
- Works best in modern browsers (Chrome, Firefox, Safari, Edge)

## Future Enhancements

Possible features to add:
- Multi-day view (week ahead)
- Filter by studio
- Push notifications for availability changes
- Export to calendar (iCal)
- Favorite time slots

## License

MIT License - Feel free to use and modify as needed!

## Acknowledgments

- Built for Dell Jewish Community Center members
- Uses Daxko Operations API for schedule data
