import threading

import config
from admin.web import create_admin_app

try:
    from waitress import serve as waitress_serve
except Exception:
    waitress_serve = None


_ADMIN_THREAD = None


def _run_server(app):
    if waitress_serve:
        waitress_serve(app, host=config.ADMIN_UI_HOST, port=config.ADMIN_UI_PORT, threads=8)
        return

    app.run(
        host=config.ADMIN_UI_HOST,
        port=config.ADMIN_UI_PORT,
        debug=False,
        use_reloader=False,
        threaded=True,
    )


def start_admin_ui():
    global _ADMIN_THREAD
    if not config.ADMIN_UI_ENABLED:
        return
    if _ADMIN_THREAD and _ADMIN_THREAD.is_alive():
        return

    app = create_admin_app()
    thread = threading.Thread(target=_run_server, args=(app,), daemon=True)
    thread.start()
    _ADMIN_THREAD = thread
    print(f"Admin UI running on http://{config.ADMIN_UI_HOST}:{config.ADMIN_UI_PORT}/admin")
