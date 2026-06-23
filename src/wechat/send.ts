import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WeChatApi } from './api.js';
import { MessageItemType, MessageType, MessageState, TypingStatus, type MessageItem, type OutboundMessage } from './types.js';
import { uploadFile } from './upload.js';
import { logger } from '../logger.js';

const TYPING_KEEPALIVE_MS = 5_000;

export function createSender(api: WeChatApi, botAccountId: string) {
  let clientCounter = 0;
  const typingTicketCache = new Map<string, { ticket: string; fetchedAt: number }>();
  const TICKET_TTL = 24 * 60 * 60 * 1000;
  const deliveryStatus = {
    lastTextSentAt: 0,
    lastFileSentAt: 0,
    lastRateLimitedAt: 0,
    lastSendFailureAt: 0,
    lastSendFailure: '',
    lastFailedKind: '',
  };

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  async function getTypingTicket(userId: string, contextToken?: string): Promise<string> {
    const cached = typingTicketCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < TICKET_TTL) {
      return cached.ticket;
    }
    try {
      const resp = await api.getConfig(userId, contextToken);
      if (resp.ret === 0 && resp.typing_ticket) {
        typingTicketCache.set(userId, { ticket: resp.typing_ticket, fetchedAt: Date.now() });
        return resp.typing_ticket;
      }
      logger.warn('getConfig returned no typing_ticket', { ret: resp.ret });
    } catch (err) {
      logger.warn('getConfig failed', { err: err instanceof Error ? err.message : String(err) });
    }
    return '';
  }

  /**
   * Start typing indicator with keepalive. Returns a stop function.
   * Fire-and-forget: errors are logged but not thrown.
   */
  function startTyping(toUserId: string, contextToken: string): () => void {
    let cancelled = false;

    (async () => {
      const ticket = await getTypingTicket(toUserId, contextToken);
      if (!ticket || cancelled) return;

      try {
        await api.sendTyping({
          ilink_user_id: toUserId,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        });
      } catch (err) {
        logger.debug('sendTyping start failed', { err: err instanceof Error ? err.message : String(err) });
        return;
      }

      // Keepalive loop
      while (!cancelled) {
        await new Promise(r => setTimeout(r, TYPING_KEEPALIVE_MS));
        if (cancelled) break;
        try {
          await api.sendTyping({
            ilink_user_id: toUserId,
            typing_ticket: ticket,
            status: TypingStatus.TYPING,
          });
        } catch {
          break;
        }
      }

      // Send CANCEL to tell WeChat we're done typing
      if (!ticket) return;
      try {
        await api.sendTyping({
          ilink_user_id: toUserId,
          typing_ticket: ticket,
          status: TypingStatus.CANCEL,
        });
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = generateClientId();

    const items: MessageItem[] = [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
    try {
      await api.sendMessage({ msg });
      deliveryStatus.lastTextSentAt = Date.now();
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      deliveryStatus.lastSendFailureAt = Date.now();
      deliveryStatus.lastSendFailure = errorText;
      deliveryStatus.lastFailedKind = 'text';
      if (errorText.includes('rate-limited')) {
        deliveryStatus.lastRateLimitedAt = Date.now();
      }
      throw err;
    }
    logger.info('Text message sent', { toUserId, clientId });
  }

  async function sendFile(toUserId: string, contextToken: string, filePath: string): Promise<void> {
    const resolved = resolve(filePath.replace(/^~/, process.env.HOME || ''));
    if (!existsSync(resolved)) {
      await sendText(toUserId, contextToken, `文件不存在: ${resolved}`);
      return;
    }

    try {
      const media = await uploadFile(api, toUserId, resolved);
      const clientId = generateClientId();

      // Convert aesKeyHex to base64: treat hex string as UTF-8, then base64 encode.
      // This matches the upstream WeChat bot media format.
      const aesKeyBase64 = Buffer.from(media.aesKeyHex).toString('base64');

      let item: MessageItem;
      if (media.mediaType === 'image') {
        item = {
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: media.encryptQueryParam,
              aes_key: aesKeyBase64,
              encrypt_type: 1,
            },
            mid_size: media.fileSize,
          },
        };
      } else {
        item = {
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: media.encryptQueryParam,
              aes_key: aesKeyBase64,
              encrypt_type: 1,
            },
            file_name: media.fileName,
            len: String(media.rawSize),
          },
        };
      }

      const msg: OutboundMessage = {
        from_user_id: botAccountId,
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [item],
      };

      logger.info('Sending file message', { toUserId, clientId, fileName: media.fileName, mediaType: media.mediaType });
      await api.sendMessage({ msg });
      deliveryStatus.lastFileSentAt = Date.now();
      logger.info('File message sent', { toUserId, clientId, fileName: media.fileName });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deliveryStatus.lastSendFailureAt = Date.now();
      deliveryStatus.lastSendFailure = msg;
      deliveryStatus.lastFailedKind = 'file';
      if (msg.includes('rate-limited')) {
        deliveryStatus.lastRateLimitedAt = Date.now();
      }
      logger.error('Failed to send file', { filePath: resolved, error: msg });
      if (!msg.includes('rate-limited')) {
        await sendText(toUserId, contextToken, `发送文件失败: ${msg}`);
      }
      throw err;
    }
  }

  function getDeliveryStatusSummary(): string {
    const now = Date.now();
    const lines: string[] = [];
    if (deliveryStatus.lastRateLimitedAt && now - deliveryStatus.lastRateLimitedAt < 30 * 60 * 1000) {
      const minutes = Math.max(1, Math.round((now - deliveryStatus.lastRateLimitedAt) / 60_000));
      lines.push(`微信发送接口最近约 ${minutes} 分钟前返回过限流，接收消息和输入中状态仍然正常，普通发送恢复后会继续可用。`);
    }
    if (deliveryStatus.lastSendFailureAt && now - deliveryStatus.lastSendFailureAt < 30 * 60 * 1000) {
      const kind = deliveryStatus.lastFailedKind === 'file' ? '文件/图片推送' : '文字回复';
      lines.push(`最近一次${kind}发送失败：${deliveryStatus.lastSendFailure}`);
    }
    if (deliveryStatus.lastTextSentAt && now - deliveryStatus.lastTextSentAt < 30 * 60 * 1000) {
      const minutes = Math.max(1, Math.round((now - deliveryStatus.lastTextSentAt) / 60_000));
      lines.push(`最近一次文字消息约 ${minutes} 分钟前发送成功。`);
    }
    if (deliveryStatus.lastFileSentAt && now - deliveryStatus.lastFileSentAt < 30 * 60 * 1000) {
      const minutes = Math.max(1, Math.round((now - deliveryStatus.lastFileSentAt) / 60_000));
      lines.push(`最近一次文件或图片约 ${minutes} 分钟前发送成功。`);
    }
    return lines.join('\n');
  }

  return { sendText, startTyping, sendFile, getDeliveryStatusSummary };
}
