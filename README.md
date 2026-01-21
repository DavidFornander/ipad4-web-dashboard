# iPad 4 Web Dashboard

A lightweight web dashboard designed for an iPad 4 (or any web browser), featuring real-time public transport departures from SL (Stockholm Public Transport).

## Features

- **SL Integration**: Real-time departures for Zinkensdamm (configurable).
- **Legacy Browser Support**: Designed to work on older WebKit versions (iPad 4/iOS 10).
- **Efficient Updates**: Uses HTMX for partial page updates without full reloads.
- **Vanilla CSS**: Responsive design without heavy framework overhead.

## Getting Started

### Prerequisites

*   **Node.js**: Version 20 or higher.
*   **Nix Users**: A `shell.nix` file is provided.

### Installation & Running

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Run the Application**:

    **Standard Method:**
    ```bash
    npm start
    ```

    **Using Nix:**
    ```bash
    nix-shell --run "npm start"
    ```

3.  Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

To change the station, edit `server.js` and update the `siteId` (default is `9296` for Zinkensdamm). You can find Site IDs using Trafiklab's API.
