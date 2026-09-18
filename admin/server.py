import json
import os
import re
import secrets
from datetime import datetime, timezone
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).parent
NEWS_PATH = ROOT.parent / "news.json"
CATEGORIES = [
    "News",
    "News - Malaysia",
    "IT / Software Engineering",
    "Business",
    "Cars",
    "AI",
    "Science",
    "Lifestyle",
    "Sports",
    "Technology",
    "Entertainment",
]
ADMIN_PASSWORD = os.environ.get("NEWS_ADMIN_PASSWORD")
SESSION_TOKEN = secrets.token_urlsafe(32)


class ArticleParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title_parts = []
        self.meta = {}
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "title":
            self.in_title = True
        if tag == "meta":
            name = (attributes.get("property") or attributes.get("name") or "").lower()
            content = attributes.get("content", "").strip()
            if name and content:
                self.meta[name] = content
        if tag == "time" and attributes.get("datetime"):
            self.meta.setdefault("time", attributes["datetime"])

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data.strip())


def fetch_article(url):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Enter a complete http:// or https:// URL.")

    request = Request(url, headers={"User-Agent": "NewsHub/1.0 article metadata reader"})
    with urlopen(request, timeout=15) as response:
        content_type = response.headers.get_content_type()
        if content_type not in ("text/html", "application/xhtml+xml"):
            raise ValueError("That URL did not return an HTML article page.")
        html = response.read(2_000_000).decode(response.headers.get_content_charset() or "utf-8", "replace")

    parser = ArticleParser()
    parser.feed(html)
    meta = parser.meta
    title = meta.get("og:title") or meta.get("twitter:title") or " ".join(parser.title_parts).strip()
    summary = meta.get("og:description") or meta.get("description") or meta.get("twitter:description") or ""
    source = meta.get("og:site_name") or parsed.hostname or ""
    date = meta.get("article:published_time") or meta.get("datepublished") or meta.get("time")
    if date:
        date = date[:10]
    else:
        date = datetime.now(timezone.utc).date().isoformat()

    if not title:
        raise ValueError("No article title could be found at that URL.")
    return {"title": title, "summary": summary, "url": url, "source": source, "date": date}


def read_news():
    return json.loads(NEWS_PATH.read_text(encoding="utf-8"))


def write_news(data):
    NEWS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def send_json(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def is_authenticated(handler):
    cookie = handler.headers.get("Cookie", "")
    return f"news_hub_session={SESSION_TOKEN}" in cookie


class NewsHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path == "/api/news":
            send_json(self, 200, read_news())
            return
        if self.path == "/api/session":
            send_json(self, 200, {
                "authenticated": is_authenticated(self),
                "configured": bool(ADMIN_PASSWORD),
            })
            return
        super().do_GET()

    def do_POST(self):
        if self.path == "/api/login":
            self.handle_login()
            return
        if self.path == "/api/logout":
            self.send_response(200)
            self.send_header("Set-Cookie", "news_hub_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict")
            self.end_headers()
            return
        if self.path not in ("/api/preview", "/api/add"):
            self.send_error(404)
            return
        if not ADMIN_PASSWORD:
            send_json(self, 503, {"error": "Set NEWS_ADMIN_PASSWORD before starting the server."})
            return
        if not is_authenticated(self):
            send_json(self, 401, {"error": "Admin sign-in required."})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length))
            if self.path == "/api/preview":
                send_json(self, 200, {"item": fetch_article(payload.get("url", "").strip())})
                return

            item = payload.get("item", {})
            url = item.get("url", "").strip()
            if not url:
                raise ValueError("The article URL is required.")
            data = read_news()
            if any(existing.get("url") == url for existing in data.get("items", [])):
                raise ValueError("That article is already in the dashboard.")
            category = item.get("category", "News")
            if category not in CATEGORIES:
                raise ValueError("Choose one of the available categories.")
            tags = [tag.strip().lower() for tag in re.split(r"[,#]", item.get("tags", "")) if tag.strip()]
            new_item = {
                "title": item.get("title", "").strip(),
                "summary": item.get("summary", "").strip(),
                "url": url,
                "source": item.get("source", "").strip(),
                "category": category,
                "tags": list(dict.fromkeys(tags)),
                "date": item.get("date") or datetime.now(timezone.utc).date().isoformat(),
            }
            if not new_item["title"]:
                raise ValueError("The article title is required.")
            data.setdefault("items", []).append(new_item)
            write_news(data)
            send_json(self, 200, {"item": new_item})
        except Exception as error:
            send_json(self, 400, {"error": str(error)})

    def handle_login(self):
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length))
        if not ADMIN_PASSWORD or not secrets.compare_digest(payload.get("password", ""), ADMIN_PASSWORD):
            send_json(self, 401, {"error": "Incorrect admin password."})
            return
        self.send_response(200)
        self.send_header("Set-Cookie", f"news_hub_session={SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, format, *args):
        if self.path.startswith("/api/"):
            super().log_message(format, *args)


if __name__ == "__main__":
    if not ADMIN_PASSWORD:
        print("Set NEWS_ADMIN_PASSWORD before using the admin importer.")
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("127.0.0.1", port), NewsHandler)
    print(f"News Hub running at http://localhost:{port}/")
    server.serve_forever()
