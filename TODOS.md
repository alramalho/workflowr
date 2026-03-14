
major features:
- [] org awareness:
    - prgressively builds org contexts by reading every thread (threads are locked for 30mins after last read not to do like a shitton of reads in succesion).
    - creates hierarchy (name, reportsTo, role, writingStyle)

- [] send me daily PRs that I need to review (vaibhav, leandro, avi)
    => Create a 'requests' field that it can read and decide when/how to help. here would be 'help me remember forgotten pr reviews', it needs an hourly cron for the day of work (8-20h), and then checks for PRs and sends me a message. careful not to spam, so awareness of what was sent when is imporant.

- create a linear agent: https://linear.app/developers/agents

- [] always aware: dont wait for triggering, but progressively build KB for org
    - get auto triggered when CONFUSION is sensed in a thread. (like people asking for context, seemingly not getting each other: tough one to do, rather under trigger then overtrigger), not just direct mentions.
    