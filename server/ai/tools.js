// Claude tool definitions for the SWFT AI agent
// Each tool maps to a Firestore operation

const tools = [
  {
    name: "create_customer",
    description: "Add a new customer to the database. Use when the user mentions a new client, homeowner, or property.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Customer's full name" },
        phone: { type: "string", description: "Phone number" },
        email: { type: "string", description: "Email address" },
        address: { type: "string", description: "Service address or home address" },
        notes: { type: "string", description: "Any notes about the customer" },
        tags: { type: "array", items: { type: "string" }, description: "Tags like 'residential', 'commercial', 'vip', 'repeat'" },
      },
      required: ["name"],
    },
  },
  {
    name: "search_customers",
    description: "Search for customers by name, phone, or email. Use to find existing customers before creating new ones.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term — name, phone number, or email" },
      },
      required: ["query"],
    },
  },
  {
    name: "update_customer",
    description: "Update an existing customer's information.",
    input_schema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "The customer's ID" },
        name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        address: { type: "string" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["customerId"],
    },
  },
  {
    name: "create_quote",
    description: "Create a new quote/estimate for a customer. Include line items with descriptions and amounts.",
    input_schema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Customer ID to associate the quote with" },
        customerName: { type: "string", description: "Customer name for display" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string", description: "Line item description (e.g., 'Labor - water heater installation')" },
              amount: { type: "number", description: "Cost for this line item" },
            },
            required: ["description", "amount"],
          },
          description: "Line items with descriptions and amounts",
        },
        notes: { type: "string", description: "Additional notes for the quote" },
      },
      required: ["customerId", "customerName", "items"],
    },
  },
  {
    name: "list_quotes",
    description: "List quotes, optionally filtered by status (draft, sent, approved, declined).",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "sent", "approved", "declined"], description: "Filter by status" },
      },
    },
  },
  {
    name: "send_quote",
    description: "Mark a quote as sent to the customer.",
    input_schema: {
      type: "object",
      properties: {
        quoteId: { type: "string", description: "The quote ID to send" },
      },
      required: ["quoteId"],
    },
  },
  {
    name: "create_invoice",
    description: "Create a new invoice for a customer. Can be created from a quote or from scratch.",
    input_schema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Customer ID" },
        customerName: { type: "string", description: "Customer name for display" },
        quoteId: { type: "string", description: "Optional quote ID this invoice is based on" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              amount: { type: "number" },
            },
            required: ["description", "amount"],
          },
        },
        dueDate: { type: "string", description: "Due date in YYYY-MM-DD format" },
        notes: { type: "string" },
      },
      required: ["customerId", "customerName", "items"],
    },
  },
  {
    name: "list_invoices",
    description: "List invoices, optionally filtered by status (open, paid, overdue).",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "paid", "overdue"], description: "Filter by status" },
      },
    },
  },
  {
    name: "create_job",
    description: "Create a new service job. Jobs track the actual work being done for a customer.",
    input_schema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "Customer ID" },
        customerName: { type: "string", description: "Customer name" },
        title: { type: "string", description: "Job title (e.g., 'Water Heater Replacement')" },
        description: { type: "string", description: "Job description and scope of work" },
        service: { type: "string", description: "Service type (e.g., 'Plumbing', 'Electrical', 'HVAC')" },
        status: { type: "string", enum: ["scheduled", "active", "pending", "complete"], description: "Job status" },
        scheduledDate: { type: "string", description: "Scheduled date in YYYY-MM-DD format" },
        cost: { type: "number", description: "Total job cost" },
        address: { type: "string", description: "Job site address" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_jobs",
    description: "List jobs, optionally filtered by status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["scheduled", "active", "pending", "complete"], description: "Filter by status" },
      },
    },
  },
  {
    name: "update_job",
    description: "Update a job's details or status.",
    input_schema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "The job ID to update" },
        title: { type: "string" },
        description: { type: "string" },
        service: { type: "string" },
        status: { type: "string", enum: ["scheduled", "active", "pending", "complete"] },
        scheduledDate: { type: "string" },
        cost: { type: "number" },
        address: { type: "string" },
      },
      required: ["jobId"],
    },
  },
  {
    name: "schedule_job",
    description: "Add a job to the schedule with a specific date and time.",
    input_schema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job ID to schedule" },
        title: { type: "string", description: "Title for the schedule entry" },
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        startTime: { type: "string", description: "Start time (e.g., '09:00')" },
        endTime: { type: "string", description: "End time (e.g., '12:00')" },
        location: { type: "string", description: "Job site location" },
        notes: { type: "string" },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "get_dashboard_stats",
    description: "Get business overview stats: total jobs, revenue, active quotes, upcoming tasks. Use when the user asks about business performance or 'how things are going'.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "send_sms",
    description: "Send a text message (SMS) to a customer or phone number. Use when the user says 'text', 'send a message to', 'let them know', or wants to notify a customer via SMS.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Phone number to text (e.g., '+15551234567')" },
        body: { type: "string", description: "The text message to send" },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "get_weather",
    description: "Get the current weather and forecast for a location. Use when the user asks about weather, whether it's safe to work outside, or wants to check conditions before scheduling a job.",
    input_schema: {
      type: "object",
      properties: {
        latitude: { type: "number", description: "Latitude of the location" },
        longitude: { type: "number", description: "Longitude of the location" },
        city: { type: "string", description: "City name (used if lat/long not available — defaults to user's area)" },
      },
    },
  },
  {
    name: "navigate_to_customer",
    description: "Open Google Maps navigation to a customer's address. Use when the user says 'take me to', 'navigate to', 'directions to [customer]', or 'how do I get to [customer]'.",
    input_schema: {
      type: "object",
      properties: {
        customerId: { type: "string", description: "The customer's ID" },
        customerName: { type: "string", description: "Customer name to search for if ID not known" },
      },
    },
  },
  {
    name: "get_directions",
    description: "Get driving directions and travel time between two addresses. Use when the user asks about drive time, how to get to a job site, or route between locations.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Starting address or location" },
        destination: { type: "string", description: "Destination address or job site" },
      },
      required: ["origin", "destination"],
    },
  },
  {
    name: "list_team_members",
    description: "List all team members in the organization. Use when the user asks about their team, crew, who's available, or wants to assign someone to a job.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "generate_estimate",
    description: "Generate an AI-powered quote estimate for a job. Uses past job data and pricing config to calculate. Use when the user asks to 'estimate', 'price out', 'how much would it cost', or 'generate a quote for'.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Description of the job (e.g., 'new driveway with broom finish')" },
        service: { type: "string", description: "Service type (e.g., 'driveway', 'patio', 'walkway')" },
        sqft: { type: "string", description: "Square footage (e.g., '500')" },
        finish: { type: "string", description: "Finish type (e.g., 'broom', 'stamped', 'exposed aggregate')" },
        customerId: { type: "string", description: "Customer ID if known" },
        customerName: { type: "string", description: "Customer name if known" },
        address: { type: "string", description: "Job site address" },
      },
    },
  },
  {
    name: "assign_job",
    description: "Assign a job to a specific team member. Use when the user says 'assign [job] to [person]' or 'give [job] to [technician]'.",
    input_schema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "The job ID to assign" },
        assigneeUid: { type: "string", description: "The UID of the team member to assign the job to" },
      },
      required: ["jobId", "assigneeUid"],
    },
  },
];

module.exports = tools;
