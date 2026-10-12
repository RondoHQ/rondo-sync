"""Deliver GlitchTip alerts through the existing Rondo Lettermint sender."""
import json
import logging
import os
import urllib.request
from django.core.mail.backends.base import BaseEmailBackend


class EmailBackend(BaseEmailBackend):
    def send_messages(self, email_messages):
        sent = 0
        for message in email_messages:
            payload = {
                "from": message.from_email,
                "to": message.to,
                "subject": message.subject,
                "text": message.body,
            }
            for alternative in getattr(message, "alternatives", []):
                if alternative[1] == "text/html":
                    payload["html"] = alternative[0]
            if message.cc:
                payload["cc"] = message.cc
            if message.bcc:
                payload["bcc"] = message.bcc
            if message.reply_to:
                payload["reply_to"] = message.reply_to
            request = urllib.request.Request(
                "https://api.lettermint.co/v1/send",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json", "Accept": "application/json",
                         "x-lettermint-token": os.environ["LETTERMINT_API_TOKEN"]},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    result = json.load(response)
                logging.getLogger(__name__).info("Lettermint accepted message %s", result.get("message_id"))
                sent += 1
            except Exception:
                if not self.fail_silently:
                    raise
        return sent
