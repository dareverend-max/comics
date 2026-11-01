# Longbox Arc Finder

A Streamlit web app that uses the [Metron](https://metron.cloud) comic database to:

1. **Summarize a run**: enter a title, publisher and start/end issue numbers to get each issue's synopsis and the story arcs it belongs to.
2. **Find where an arc ends**: enter one issue number to see the arc it's part of, the issues still to read (including tie-ins from other series), and the issue and date where the arc finishes.

## Deploy on Streamlit Community Cloud

1. Go to <https://share.streamlit.io> and click **Create app**, then choose **Deploy a public app from GitHub**.
2. Repository `dareverend-max/comics`, branch `main`, main file `streamlit_app.py`.
3. Open **Advanced settings → Secrets** and paste:
   ```toml
   METRON_TOKEN = "your-metron-api-token"
   ```
   Generate the token on your metron.cloud account page.
4. Click **Deploy**.

## Run locally

```bash
pip install -r requirements.txt
cp .streamlit/secrets.toml.example .streamlit/secrets.toml   # then add your token
streamlit run streamlit_app.py
```

Metron allows about 30 requests a minute, so one run summarizes at most 25 issues. Results are cached for 12 hours.
