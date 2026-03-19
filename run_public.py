"""
Startet GeoAI öffentlich über ngrok.
Alle mit dem Link können mitspielen solange dieser PC läuft.

Voraussetzung:
  pip install pyngrok flask

Kostenloses ngrok-Konto: https://ngrok.com  (kostenlos, kein Token nötig für kurze Sessions)
"""
from pyngrok import ngrok
import threading, app as flask_app

# Flask in eigenem Thread starten
def run_flask():
    flask_app.app.run(port=5000, use_reloader=False)

t = threading.Thread(target=run_flask, daemon=True)
t.start()

# Öffentliche URL erstellen
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
