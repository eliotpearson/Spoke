import _ from "lodash";
import { Assignment, r, cacheableData } from "../models";
import { addWhereClauseForContactsFilterMessageStatusIrrespectiveOfPastDue } from "./assignment";
import { addCampaignsFilterToQuery } from "./campaign";
import { log } from "../../lib";
import { getConfig } from "../api/lib/config";
import { isSqlite } from "../models/index";

function getConversationsJoinsAndWhereClause(
  queryParam,
  organizationId,
  { campaignsFilter, assignmentsFilter, contactsFilter, messageTextFilter },
  forData
) {
  let query = queryParam
    .from("campaign_contact")
    .join("campaign", "campaign.id", "campaign_contact.campaign_id");

  query = addCampaignsFilterToQuery(query, campaignsFilter, organizationId);

  if (
    assignmentsFilter &&
    assignmentsFilter.texterId &&
    !assignmentsFilter.sender
  ) {
    if (assignmentsFilter.texterId === -2) {
      // unassigned
      query = query.whereNull("campaign_contact.assignment_id");
    } else {
      query = query.where({ "assignment.user_id": assignmentsFilter.texterId });
    }
  }
  if (
    forData ||
    (assignmentsFilter &&
      assignmentsFilter.texterId &&
      !assignmentsFilter.sender)
  ) {
    query = query
      .leftJoin("assignment", "campaign_contact.assignment_id", "assignment.id")
      .leftJoin("user", "assignment.user_id", "user.id")
      .leftJoin("user_organization", function joinUserOrg() {
        this.on("user_organization.user_id", "=", "user.id").andOn(
          "user_organization.organization_id",
          "=",
          "campaign.organization_id"
        );
      });
  }

  if (
    !forData &&
    (messageTextFilter || (assignmentsFilter && assignmentsFilter.sender))
  ) {
    // NOT forData -- just for filter -- and then we need ALL the messages
    query.join(
      "message AS msgfilter",
      "msgfilter.campaign_contact_id",
      "campaign_contact.id"
    );
    if (messageTextFilter) {
      query.where("msgfilter.text", "LIKE", `%${messageTextFilter}%`);
    }
    if (
      assignmentsFilter &&
      assignmentsFilter.sender &&
      assignmentsFilter.texterId
    ) {
      query.where("msgfilter.user_id", assignmentsFilter.texterId);
    }
  }

  query = addWhereClauseForContactsFilterMessageStatusIrrespectiveOfPastDue(
    query,
    contactsFilter && contactsFilter.messageStatus
  );

  if (contactsFilter.updatedAtGt) {
    query = query.andWhere(function() {this.where('updated_at', '>', contactsFilter.updatedAtGt)})
  }
  if (contactsFilter.updatedAtLt) {
    query = query.andWhere(function() {this.where('updated_at', '<', contactsFilter.updatedAtLt)})
  }

  if (contactsFilter) {
    if ("isOptedOut" in contactsFilter) {
      query.where("is_opted_out", contactsFilter.isOptedOut);
    }

    if (contactsFilter.errorCode && contactsFilter.errorCode.length) {
      if (contactsFilter.errorCode[0] === 0) {
        query.whereNull("campaign_contact.error_code");
      } else {
        query.whereIn("campaign_contact.error_code", contactsFilter.errorCode);
      }
    }

    if (contactsFilter.tags) {
      const tags = contactsFilter.tags;

      let tagsSubquery = r.knexReadOnly
        .select(1)
        .from("tag_campaign_contact")
        .whereRaw(
          "campaign_contact.id = tag_campaign_contact.campaign_contact_id"
        );

      if (tags.length === 0) {
        // no tags
        query = query.whereNotExists(tagsSubquery);
      } else if (tags.length === 1 && tags[0] === "*") {
        // any tag
        query = query.whereExists(tagsSubquery);
      } else {
        tagsSubquery = tagsSubquery.whereIn("tag_id", tags);
        query = query.whereExists(tagsSubquery);
      }
    }

    if (contactsFilter.suppressedTags) {
      const tags = contactsFilter.suppressedTags.map(id =>
        id.replace("s_", "")
      );

      if (tags.length >= 1) {
        query = query.whereNotExists(
          r.knexReadOnly
            .select(1)
            .from("tag_campaign_contact")
            .whereRaw(
              "campaign_contact.id = tag_campaign_contact.campaign_contact_id"
            )
            .whereIn("tag_id", tags)
        );
      }
    }

    if (contactsFilter.orderByRaw) {
      query = query.orderByRaw(contactsFilter.orderByRaw);
    }
  }

  return query;
}

/*
This is necessary because the SQL query that provides the data for this resolver
is a join across several tables with non-unique column names.  In the query, we
alias the column names to make them unique.  This function creates a copy of the
results, replacing keys in the fields map with the original column name, so the
results can be consumed by downstream resolvers.
 */
function mapQueryFieldsToResolverFields(queryResult, fieldsMap) {
  const data = _.mapKeys(queryResult, (value, key) => {
    const newKey = fieldsMap[key];
    if (newKey) {
      return newKey;
    }
    return key;
  });
  if (typeof data.updated_at != "undefined") {
    data.updated_at = (
      data.updated_at instanceof Date || !data.updated_at
      ? data.updated_at || null
      : new Date(data.updated_at))
  }
  return data;
}

export async function getConversations(
  cursor,
  organizationId,
  { campaignsFilter, assignmentsFilter, contactsFilter, messageTextFilter },
  utc,
  includeTags,
  awsContext,
  options
) {
  /* Query #1 == get campaign_contact.id for all the conversations matching
   * the criteria with offset and limit. */
  const starttime = new Date();
  let offsetLimitQuery = r.knexReadOnly.select("campaign_contact.id as cc_id");

  offsetLimitQuery = getConversationsJoinsAndWhereClause(
    offsetLimitQuery,
    organizationId,
    {
      campaignsFilter,
      assignmentsFilter,
      contactsFilter,
      messageTextFilter
    }
  );
  if (options && options.justIdQuery) {
    return { query: offsetLimitQuery };
  }

  if (cursor.limit || cursor.offset) {
    if (!getConfig("CONVERSATIONS_RECENT")) {
      offsetLimitQuery = offsetLimitQuery.orderBy("cc_id", "desc");
    }

    offsetLimitQuery = offsetLimitQuery
      .limit(cursor.limit)
      .offset(cursor.offset);
  }
  console.log(
    `Org Id: ${organizationId} :: getConversations sql -- \n`,
    `\tawsContext: ${awsContext && awsContext.awsRequestId ? true : false}\n`,
    `\tcursor: limit=${cursor.limit}, offset=${cursor.offset}\n`,
    `\tassignmentsFilter: ${Object.keys(assignmentsFilter).length > 0 ? assignmentsFilter : "no filter"}\n`,
    `\toffsetLimitQuery: ${offsetLimitQuery.toString()}`
  );

  const ccIdRows = await offsetLimitQuery;

  console.log(
    `Org Id: ${organizationId} :: getConversations query1 contact ids -- \n`,
    `\tawsContext: ${awsContext && awsContext.awsRequestId === undefined ? true : false}\n`,
    `\ttime: ${Number(new Date()) - Number(starttime)}ms\n`,
    `\tccIdRows length: ${ccIdRows.length}`
  );
  const ccIds = ccIdRows.map(ccIdRow => {
    return ccIdRow.cc_id;
  });
  /* Query #2 -- get all the columns we need, including messages, using the
   * cc_ids from Query #1 to scope the results to limit, offset */
  let query = r.knexReadOnly.select(
    "campaign_contact.id as cc_id",
    "campaign_contact.first_name as cc_first_name",
    "campaign_contact.last_name as cc_last_name",
    "campaign_contact.cell",
    "campaign_contact.error_code",
    "campaign_contact.message_status",
    "campaign_contact.is_opted_out",
    "campaign_contact.updated_at",
    "assignment.id as assignment_id",
    "user.id as u_id",
    "user.first_name as u_first_name",
    "user.last_name as u_last_name",
    "user_organization.role as u_role",
    "campaign.id as cmp_id",
    "campaign.title",
    "campaign.due_by",
    "assignment.id as ass_id",
    "message.id as mess_id",
    "message.text",
    "message.user_number",
    "message.contact_number",
    "message.created_at",
    "message.is_from_contact"
  );

  query = getConversationsJoinsAndWhereClause(
    query,
    organizationId,
    {
      campaignsFilter,
      assignmentsFilter,
      contactsFilter,
      messageTextFilter
    },
    true
  );

  query = query.whereIn("campaign_contact.id", ccIds);

  query = query.leftJoin("message", table => {
    table.on("message.campaign_contact_id", "=", "campaign_contact.id");
  });

  query = query.orderBy("cc_id", "desc").orderBy("message.id");
  const conversationRows = await query;
  console.log(
    `Org Id: ${organizationId} :: getConversations query2 conversations -- \n`,
    `\tawsContext: ${awsContext && awsContext.awsRequestId === undefined ? true : false}\n`,
    `\ttime: ${Number(new Date()) - Number(starttime)}ms\n`,
    `\tconversationRows lenght: ${conversationRows.length}`
  );
  /* collapse the rows to produce an array of objects, with each object
   * containing the fields for one conversation, each having an array of
   * message objects */
  const messageFields = [
    "mess_id",
    "text",
    "user_number",
    "contact_number",
    "created_at",
    "is_from_contact"
  ];

  let ccId = undefined;
  let conversation = undefined;
  const conversations = [];
  for (const conversationRow of conversationRows) {
    if (ccId !== conversationRow.cc_id) {
      ccId = conversationRow.cc_id;
      conversation = _.omit(conversationRow, messageFields);
      conversation.messages = [];
      conversation.organization_id = Number(organizationId);
      conversations.push(conversation);
    }
    conversation.messages.push(
      mapQueryFieldsToResolverFields(_.pick(conversationRow, messageFields), {
        mess_id: "id"
      })
    );
  }

  // tags query
  if (includeTags) {
    const tagsQuery = r.knexReadOnly
      .select(
        "tag_campaign_contact.campaign_contact_id as campaign_contact_id",
        "tag.name as name",
        "tag.id as id",
        "tag_campaign_contact.value as value"
      )
      .from("tag_campaign_contact")
      .join("tag", "tag.id", "=", "tag_campaign_contact.tag_id")
      .whereIn("campaign_contact_id", ccIds);

    const rows = await tagsQuery;

    const contactTags = {};
    rows.forEach(tag => {
      const campaignContactId = Number(tag.campaign_contact_id);
      contactTags[campaignContactId] = contactTags[campaignContactId] || [];
      contactTags[campaignContactId].push(tag);
    });

    conversations.forEach(convo => {
      // eslint-disable-next-line no-param-reassign
      convo.tags = contactTags[convo.cc_id];
    });
  }

  /* Query #3 -- get the count of all conversations matching the criteria.
   * We need this to show total number of conversations to support paging */
  console.log(
    "getConversations query3 total count + time for total completion of queries\n",
    `\ttime: ${Number(new Date()) - Number(starttime)}ms\n`,
    `\ttotal conversations: ${conversations.length}`
  );
  const conversationsCountQuery = getConversationsJoinsAndWhereClause(
    r.knexReadOnly,
    organizationId,
    {
      campaignsFilter,
      assignmentsFilter,
      contactsFilter,
      messageTextFilter
    }
  );
  let conversationCount;
  try {
    conversationCount = await r.getCount(
      !isSqlite ?
      conversationsCountQuery.timeout(4000, { cancel: true }) :
      conversationsCountQuery
    );
  } catch (err) {
    // default fake value that means 'a lot'
    conversationCount = 9999;
    console.log("getConversations timeout", err);
  }

  const pageInfo = {
    limit: cursor.limit,
    offset: cursor.offset,
    total: conversationCount
  };

  return {
    conversations,
    pageInfo
  };
}

export async function getCampaignIdContactIdsMaps(
  organizationId,
  { campaignsFilter, assignmentsFilter, contactsFilter, messageTextFilter }
) {
  let query = r.knex.select(
    "campaign_contact.id as cc_id",
    "campaign.id as cmp_id"
  );

  query = getConversationsJoinsAndWhereClause(query, organizationId, {
    campaignsFilter,
    assignmentsFilter,
    contactsFilter,
    messageTextFilter
  });

  query = query.orderBy("cc_id");

  const conversationRows = await query;

  const campaignIdContactIdsMap = new Map();

  let ccId = undefined;
  for (const conversationRow of conversationRows) {
    if (ccId !== conversationRow.cc_id) {
      const ccId = conversationRow.cc_id;
      campaignIdContactIdsMap[conversationRow.cmp_id] = ccId;

      if (!campaignIdContactIdsMap.has(conversationRow.cmp_id)) {
        campaignIdContactIdsMap.set(conversationRow.cmp_id, []);
      }

      campaignIdContactIdsMap.get(conversationRow.cmp_id).push(ccId);
    }
  }

  return {
    campaignIdContactIdsMap
  };
}

export async function reassignConversations(
  campaignIdContactIdsMap,
  newTexterUserId
) {
  // ensure existence of assignments
  const campaignIdAssignmentIdMap = new Map();
  for (const [campaignId, _] of campaignIdContactIdsMap) {
    if (newTexterUserId === null || newTexterUserId === "-2") {
      campaignIdAssignmentIdMap.set(campaignId, null);
      continue;
    }
    let assignment = await r
      .table("assignment")
      .getAll(newTexterUserId, { index: "user_id" })
      .filter({ campaign_id: campaignId })
      .limit(1)(0)
      .default(null);
    if (!assignment) {
      assignment = await Assignment.save({
        user_id: newTexterUserId,
        campaign_id: campaignId,
        max_contacts: parseInt(process.env.MAX_CONTACTS_PER_TEXTER || 0, 10)
      });
    }
    campaignIdAssignmentIdMap.set(campaignId, assignment.id);
  }

  // do the reassignment
  const returnCampaignIdAssignmentIds = [];

  // TODO(larry) do this in a transaction!
  try {
    for (const [campaignId, campaignContactIds] of campaignIdContactIdsMap) {
      const assignmentId = campaignIdAssignmentIdMap.get(campaignId);

      /* NOTE: psql prepared statements can only handle a max of ~65k
         so if a campaign is larger than that it has to be chunked
         https://github.com/brianc/node-postgres/issues/1091
         https://stackoverflow.com/questions/6581573/what-are-the-max-number-of-allowable-parameters-per-database-provider-type */

      for (const ccIds of _.chunk(campaignContactIds, 65000)) {
        await r
          .knex("campaign_contact")
          .where("campaign_id", campaignId)
          .whereIn("id", ccIds)
          .update({
            assignment_id: assignmentId
          });

        // Clear the DataLoader cache for the campaign contacts affected by the foregoing
        // SQL statement to keep the cache in sync.  This will force the campaignContact
        // to be refreshed. We also update the assignment in the cache
        await Promise.all(
          ccIds.map(async campaignContactId =>
            cacheableData.campaignContact.updateAssignmentCache(
              campaignContactId,
              assignmentId,
              newTexterUserId,
              campaignId
            )
          )
        );

        returnCampaignIdAssignmentIds.push({
          campaignId,
          assignmentId: assignmentId?.toString()
        });
      }
    }
  } catch (error) {
    log.error(error);
  }

  return returnCampaignIdAssignmentIds;
}

export const resolvers = {
  PaginatedConversations: {
    conversations: queryResult => {
      return queryResult.conversations;
    },
    pageInfo: queryResult => {
      if ("pageInfo" in queryResult) {
        return queryResult.pageInfo;
      } else {
        return null;
      }
    }
  },
  Conversation: {
    texter: queryResult => {
      // console.log("getConversation texter");
      return mapQueryFieldsToResolverFields(queryResult, {
        u_id: "id",
        u_first_name: "first_name",
        u_last_name: "last_name",
        u_role: "role"
      });
    },
    contact: queryResult => {
      // console.log("getConversation contact", queryResult);
      return mapQueryFieldsToResolverFields(queryResult, {
        cc_id: "id",
        cc_first_name: "first_name",
        cc_last_name: "last_name"
      });
    },
    campaign: queryResult => {
      // console.log("getConversation campaign");
      return mapQueryFieldsToResolverFields(queryResult, { cmp_id: "id" });
    }
  }
};
