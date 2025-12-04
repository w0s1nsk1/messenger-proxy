# Messenger Proxy

Prosty proxy/webhook dla Messengera, który reaguje na wiadomości i może używać Playwrighta do akcji w przeglądarce.

## Szybki start
- `npm install`
- Ustaw zmienne (np. w `.env` lub eksporcie): `PORT=3000`, `FB_EMAIL`, `FB_PASSWORD`.
- Opcjonalnie: `STORAGE_STATE` (ścieżka do pliku ze stanem zalogowanej sesji Playwright – jeśli istnieje, zostanie użyty; jeśli nie, po udanym logowaniu zostanie zapisany), `LOGIN_MODE` (`credentials` domyślnie, `storage-only` – wymagany istniejący plik stanu, `manual` – tryb ręcznego logowania i zapisu stanu), `MESSENGER_PIN` (6-cyfrowy PIN do automatycznego odblokowania historii czatu, jeśli wyskoczy prompt), `WATCH_CONVERSATION` (nazwa konwersacji do podglądu) lub `WATCH_CONVERSATION_ID` (ID konwersacji z końcówki href), `WATCH_POLL_MS` (odstęp odpytywania, domyślnie 10000), `WATCH_LIMIT` (ile wiadomości pobrać na raz, domyślnie 10).
- `npm start` uruchomi serwer na podanym porcie.
- Aby ręcznie zalogować się w Playwright i zapisać `STORAGE_STATE`, użyj `npm run login:manual` (otworzy się okno, zaloguj się, zamknij kartę – stan zostanie zapisany, proces się zakończy; serwer/watcher w tym trybie nie startuje).
- Opcjonalnie możesz podać `SQLITE_DB_PATH=/pełna/ścieżka/do/bazy.sqlite` oraz zainstalować zależność `sqlite3`, aby logować nowe wiadomości wyłapane przez watcher do bazy SQLite.
- Gdy podasz `ERROR_SCREENSHOT_DIR` (domyślnie `storage/screenshots`), każda awaria `readMessages` zapisze zrzut ekranu z Playwrighta i poda jego ścieżkę w logach.

## Endpoints
- `GET /health` – szybki check stanu.
- `POST /notify` – prosty endpoint dla innych aplikacji: body JSON `{"conversation": "...", "message": "..."}`; wysyła wiadomość na Messengera.

## Notatki
- W pliku `src/server.js` znajdziesz miejsce na integrację z Messenger Send API (wysyłka odpowiedzi). Obecnie tylko logujemy zdarzenia i wykonujemy Playwrighta.
- Playwright jest dość ciężki; pierwsze `npm install` może potrwać. Jeśli chcesz lżejszy build, możesz zmienić zależność na np. `playwright-chromium`.
- Jeśli ustawisz `WATCH_CONVERSATION`, proces w tle będzie okresowo czytał ostatnie wiadomości z tej rozmowy i logował nowe w konsoli (prefiks `[Incoming][<nazwa>] ...`).
- Jeśli aktywujesz `SQLITE_DB_PATH`, każda nowa wiadomość z watchera zostanie dopisana do tabeli `messages` (kolumny: `conversation_key`, `conversation_id`, `conversation_name`, `sender`, `text`, `logged_at`). Dzięki temu możesz później samodzielnie wykonywać zapytania `sqlite3 storage/messages.sqlite 'SELECT * FROM messages ORDER BY logged_at DESC LIMIT 20;'`.
- Przy błędach odczytu wiadomości automatycznie zapisujemy screenshot (`ERROR_SCREENSHOT_DIR`), co ułatwia debug.
