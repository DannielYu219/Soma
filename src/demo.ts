export type ResponseKind = 'conversation' | 'creation' | 'revision'
export interface Reply { text: string[]; kind: ResponseKind }

export const initialDocument = {
  title: '雨停以前',
  subtitle: '短篇散文',
  text: '雨从下午一直落到傍晚。\n\n窗外的树，颜色比平时深了一点。有人撑着伞经过，在路口停住，像是在等什么，又像只是想把这一小段路走得慢一些。\n\n我把窗户推开一道缝。潮湿的空气进来，带着泥土和很远的饭菜的气味。\n\n本来有一些非做不可的事。这会儿，它们忽然可以再等一等。\n\n天还没有暗下来。雨也没有要停的意思。',
}

/** Interaction fixtures only. No model requests, memory, or hidden uploads. */
export function demoReply(input: string, hasDocument: boolean, turn = 0): Reply {
  if (hasDocument && /短一点|再短|精简|收紧|删掉|少一些/.test(input)) return {
    kind: 'revision',
    text: ['删去了一些解释，留下窗、雨和那个没有赶路的人。修改放在项目里了。'],
  }
  if (/(写|创作|做).{0,12}(散文|故事|诗|文章|文案|短文|一段|一个)|写下来|写成|新建.{0,4}项目/.test(input)) return {
    kind: 'creation',
    text: ['可以，从一个雨天的傍晚开始，不急着说明它意味着什么。', '我把这段放进一个单独的项目。我们可以在那里慢慢改，这里的对话也会留着。'],
  }
  if (/累|难过|低落|焦虑|孤独|烦|心情|情绪|开心不起来/.test(input)) return {
    kind: 'conversation',
    text: ['有时候最累的不是某一件事，而是一天里一直没有真正松下来。', '现在不一定要找到解决办法。你想说的话，可以从最没头绪的那一点说起。'],
  }
  if (/你好|hello|嗨|在吗/i.test(input)) return {
    kind: 'conversation', text: ['在。今天有什么想聊的？'],
  }
  if (/雨|天气|窗|傍晚|散步/.test(input)) return {
    kind: 'conversation',
    text: ['雨天会把一些平时听不见的声音带回来。落在窗沿上的、树叶上的，还有远处车轮碾过积水的声音。', '好像外面的世界忙着下雨，人就可以暂时不那么着急。'],
  }
  if (/意义|思考|生活|为什么|想法|设计|工具|安静/.test(input)) return {
    kind: 'conversation',
    text: ['也许可以先分开看：我们是真的想做这件事，还是觉得自己应该想做？这两种感觉很像，走下去却会到不同的地方。', '不急着给它一个完整答案。先说说，哪一部分是你自己在意的。'],
  }
  return {
    kind: 'conversation',
    text: turn > 0
      ? ['先不把它归纳成一个结论。你刚才说的里面，哪一点是你还想多停留一会儿的？']
      : ['听起来，这件事还没有完全想清楚。没关系，可以边说边想。', '你最先想到的是什么？'],
  }
}

export const shorterDocument = '雨一直下到傍晚。\n\n窗外有人撑着伞，在路口停了一会儿。\n\n我推开窗。潮湿的空气进来，带着很远的饭菜的气味。\n\n那些非做不可的事，忽然都可以再等一等。'
