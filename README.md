# iPad 4 Web Dashboard

A Next.js dashboard designed for an iPad 4 (or any web browser), featuring real-time public transport departures from SL (Stockholm Public Transport).

## Features

- **SL Integration**: Real-time departures for Zinkensdamm (configurable).
- **Modular Design**: Easy to add new widgets.
- **Responsive UI**: Built with Tailwind CSS.

## Getting Started

1.  **Prerequisites**:
    *   Node.js 18+ (or use `nix-shell` if on NixOS).

2.  **Install Dependencies**:
    ```bash
    npm install
    ```

3.  **Run Development Server**:
    ```bash
    npm run dev
    ```

4.  Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

To change the station, edit `app/api/departures/route.ts` and update the `DEFAULT_SITE_ID`. You can find Site IDs using Trafiklab's "SL Hållplatsuppslag" API or by searching online. Zinkensdamm is `9296`.
