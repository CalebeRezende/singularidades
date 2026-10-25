// Envio de notificação push (Web Push / aes128gcm, padrão aceito pelo
// iPhone/Safari também) usando a mesma API do navegador (sem WhatsApp).

import { buildPushPayload } from '@block65/webcrypto-web-push';

const VAPID_SUBJECT = 'mailto:contato@singularidades.app';

// Envia a notificação pra UMA inscrição. Retorna { ok, expired } —
// expired=true significa que a inscrição não existe mais (navegador
// desinstalou/revogou) e deve ser removida do armazenamento.
export async function sendPush(subscription, vapidPublicKey, vapidPrivateKey, { title, body }) {
  const vapid = { subject: VAPID_SUBJECT, publicKey: vapidPublicKey, privateKey: vapidPrivateKey };
  const message = {
    data: JSON.stringify({ title, body }),
    options: { ttl: 60 * 60 },
  };

  const payload = await buildPushPayload(message, subscription, vapid);
  const res = await fetch(subscription.endpoint, payload);

  if (res.status === 404 || res.status === 410) {
    return { ok: false, expired: true };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Falha ao enviar push: ${res.status} - ${text.slice(0, 200)}`);
  }
  return { ok: true, expired: false };
}

// Envia pra todas as inscrições de uma agenda, removendo as expiradas.
// Retorna a lista de inscrições ainda válidas (pra regravar no KV).
export async function sendPushToAll(subscriptions, vapidPublicKey, vapidPrivateKey, notif) {
  const ainda = [];
  let enviouAlgum = false;

  for (const sub of subscriptions) {
    try {
      const { ok, expired } = await sendPush(sub, vapidPublicKey, vapidPrivateKey, notif);
      if (expired) continue; // não adiciona de volta -> remove da lista
      ainda.push(sub);
      if (ok) enviouAlgum = true;
    } catch (e) {
      console.log('Falha ao enviar push pra uma inscrição:', e.message);
      ainda.push(sub); // mantém a inscrição, pode ter sido falha transitória
    }
  }

  return { subscriptions: ainda, enviouAlgum };
}
