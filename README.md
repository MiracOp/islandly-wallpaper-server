# Islandly Wallpaper Server

Small Railway-ready API and admin panel for managing remote wallpapers.

## Run locally

```bash
cd railway-wallpaper-server
ADMIN_TOKEN=dev-token npm start
```

Open:

```text
http://localhost:3000
```

Public API:

```text
GET /api/wallpapers
```

Admin API requires `x-admin-token`.

## Deploy to Railway

1. Create a new Railway project from this folder.
2. Set the start command to `npm start` if Railway does not detect it.
3. Add an environment variable:

```text
ADMIN_TOKEN=choose-a-long-random-token
```

4. After deploy, copy the Railway domain.
5. In the iOS app, update `baseURLString` in:

```text
DynamicIslandWallpapers/DynamicIslandWallpapers/Wallpapers/RemoteRealWallpaperService.swift
```

Example:

```swift
private let baseURLString = "https://your-project.up.railway.app"
```

## Important

This MVP stores wallpaper metadata in `data/wallpapers.json`. On Railway, use a persistent volume or migrate this to PostgreSQL before production. Store the actual image files on Cloudinary, S3, R2, or another object storage service, and paste their public URLs into the admin panel.
