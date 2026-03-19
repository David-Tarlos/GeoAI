"""
Startet GeoAI öffentlich über ngrok.
Alle mit dem Link können mitspielen solange dieser PC läuft.

Voraussetzung:
  pip install pyngrok flask flask-socketio
"""
from pyngrok import ngrok
import threading
import app as flask_app

def run():
    flask_app.socketio.run(flask_app.app, port=5000, use_reloader=False, allow_unsafe_werkzeug=True)

t = threading.Thread(target=run, daemon=True)
t.start()

public_url = ngrok.connect(5000)
print()
print('━' * 50)
print(f'  Öffentlicher Link:')
print(f'  {public_url}')
print()
print('  Teile diesen Link – jeder kann mitspielen!')
print('  Beenden: Strg+C')
print('━' * 50)

try:
    input()
except KeyboardInterrupt:
    pass
finally:
    ngrok.kill()
