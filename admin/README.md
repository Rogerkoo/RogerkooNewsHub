# News Hub admin

The root `index.html` is the public reader for GitHub Pages. This folder is a separate Vercel admin app. It fetches article metadata and commits the reviewed item to `news.json` in GitHub. GitHub Pages then publishes the updated JSON.

## What this app does

1. Sign in with your admin password.
2. Paste an article URL and fetch automatic metadata.
3. Review or tweak title, summary, source, and date.
4. Choose a category and tags manually.
5. Save the article to `news.json` via a GitHub commit.

## Vercel setup

Deploy this folder as its own Vercel project. Add these environment variables:

- `NEWS_ADMIN_PASSWORD`: a strong admin password.
- `GITHUB_TOKEN`: a fine-grained GitHub token with `Contents: Read and write` access to the repository.
- `GITHUB_REPO`: repository in `owner/name` form.
- `GITHUB_BRANCH`: branch containing the public page, usually `main`.

Open the deployed admin URL at `/`, sign in, paste an article URL, review the automatic fields, choose a category, and add tags. The API validates the category and creates a GitHub commit for each article.

## Privacy

- The admin dashboard and `/api/news` require sign-in.
- Keep the Vercel admin URL private. Do not link it from the public GitHub Pages site.
- The public reader at the repo root does not include the importer or any admin credentials.
- Do not commit environment variable values to the repository.

## Local development

For local testing without Vercel or GitHub:

```powershell
cd admin
$env:NEWS_ADMIN_PASSWORD = "your-password"
python server.py
```

Then open `http://localhost:8000/`. Local mode writes directly to the repo-root `news.json`.

## Notes

- After saving on Vercel, GitHub Pages may take a minute or two to show the new article on the public site.
- Duplicate article URLs are rejected.
- Categories must match the allowlist in `api/index.js`.
