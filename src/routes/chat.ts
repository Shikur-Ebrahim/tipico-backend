import { Router } from 'express';
import { postChatMessage } from '../controllers/chatController';

const router = Router();

router.post('/', postChatMessage);

export default router;
