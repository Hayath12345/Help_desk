# Skills-based auto-assignment

A new ticket is handed to the right person on its team, based on **skills**, instead of waiting in the
team queue for someone to pick it up.

## How it works, in one minute

1. A Super Admin keeps a list of **skills** (_Network_, _CCTV_, _Windows_ …) under **Admin → Skills**.
2. Each **staff member** has the skills they are good at (**Admin → Staff → edit → Skills**).
3. Each **category** lists the skills it needs (**Admin → Categories → edit → Skills needed**).
4. When a ticket is created in that category, the system looks at the category's **team** and picks:
   - members who have **at least one** of the skills the category needs,
   - whose account is **active** and who are **taking automatic tickets** (see _Pausing_ below),
   - then the one with the **fewest open tickets** (NEW / OPEN / PENDING, across all teams).
   - A tie goes to whoever was **handed a ticket automatically longest ago** (never = first).
5. If nobody qualifies, nothing changes: the ticket waits in the team queue, as it always did.

The assignee sees it in their Inbox, gets an in-app notification ("LG-4821 was assigned to you"), and
the ticket history says **"Automatically assigned to … (matched by skill)"**. Status stays **New**
until they touch it, like any ticket raised by a client.

## What is never assigned automatically

| Case                                                           | Why                                                                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **P1** tickets                                                 | They go through the on-call escalation chain; whoever acknowledges takes it. (`AUTO_ASSIGN_SKIPS` in `services/auto-assign.ts`.) |
| A category with **no skills** set                              | Auto-assignment is opt-in per category. Existing categories behave exactly as before.                                            |
| A ticket raised by a **staff member of the same team**         | They take it themselves (unchanged). A staff member raising it for another team's category does get the automatic pick.          |
| Re-routing or editing an existing ticket                       | Only _creation_ picks someone. Moving a ticket to another team still hands it to that team's queue.                              |
| Staff who are **disabled**, **paused**, or **not on the team** | Even if they have the skill.                                                                                                     |

## Pausing someone (leave, sick day)

Edit the person under **Admin → Staff** and switch off **Takes automatic tickets**. They stay on their
teams, keep their skills, and can still be assigned by hand; they just aren't picked automatically.
The staff list shows a **Paused** badge.

## Archived skills

Archiving a skill keeps it on the staff and categories that have it but it **stops counting** for
matching, and it can't be newly added anywhere. Restoring it brings the old setup back unchanged.

## Setting it up for a team (example: IT, three engineers)

1. **Skills:** add _Network_, _Desktop support_, _Software_.
2. **Staff:** give Aisha _Network_; Omar _Desktop support_ + _Software_; Lina _Software_.
3. **Categories:** _Network & Connectivity_ needs _Network_; _Software & Applications_ needs
   _Software_; _IT Service Desk_ needs _Desktop support_.
4. A software ticket now goes to Omar or Lina, whichever has fewer open tickets. A network ticket goes
   to Aisha. If Aisha is on leave, pause her: network tickets stay in the queue for the team lead.

Tip: to make a second person a fallback for a skill, just give them that skill too.

## For developers

- Data: `Skill`, `UserSkill`, `CategorySkill`, `User.acceptsAutoAssign` (migration `20261004120000_skills_auto_assign`).
- Logic: `apps/api/src/services/auto-assign.ts` (`pickAutoAssignee`, the pure `chooseAssignee`), called inside the
  create-ticket transaction in `tickets.service.ts`. The `ASSIGNEE_CHANGED` event has no actor and
  `meta: { auto: true }`; the history, the tie-break and the in-app notification all key off that.
- Notification: `jobs/events.ts` (`ticket-created`) adds a `TICKET_ASSIGNED` in-app notification for the
  assignee when the event is an automatic one (nobody is told about a ticket they took themselves).
- Admin API: `GET/POST /admin/skills`, `PATCH /admin/skills/:id`, `POST /admin/skills/:id/archive|restore`,
  `PUT /admin/staff/:id/skills`, `PUT /admin/categories/:id/skills`, `PATCH /admin/staff/:id`
  (`acceptsAutoAssign`). Contracts: `packages/shared/src/schemas/admin/skills.ts`. Super admins only.
- Realtime: every skills change announces the `skills` config scope, which refreshes the Skills, Staff and
  Categories screens of other open admins.
- Tests: `apps/api/test/auto-assign.test.ts` (rules end to end), `admin-skills.test.ts` (admin API),
  `apps/api/src/services/auto-assign.test.ts` (the pick).
- Seed: the demo seed adds a starter catalog and gives the demo staff their skills, but links **no**
  category, so nothing is assigned automatically until an admin picks skills for a category.

## Not built (ideas)

- Team leads maintaining skills for their own team (today: Super Admins only).
- Round-robin without skills; skill levels (junior / senior); a per-person daily cap.
- Availability from a calendar or a shift rota instead of the manual **Takes automatic tickets** switch.
- Re-picking when the assignee pauses themselves or is disabled while holding open tickets.
