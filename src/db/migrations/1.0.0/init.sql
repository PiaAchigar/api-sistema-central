-- ==============================================================================
-- 1. CREACIÓN DE TABLAS (SIN LLAVES FORÁNEAS)
-- ==============================================================================

-- SCHEMA: SERVICES & TRAINING
CREATE TABLE CATEGORIES (
    id UUID PRIMARY KEY,
    parent_category_id UUID, -- nullable - recursivo
    name VARCHAR(255),
    description TEXT,
    display_order INTEGER,
    is_active BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE SERVICE_CATEGORY (
    service_id UUID,
    category_id UUID,
    created_at TIMESTAMP
    -- No PK explicitly defined in Mermaid, assuming composite or none
);

CREATE TABLE TRAINING_SCHEDULES (
    id UUID PRIMARY KEY,
    training_id UUID,
    session_number INTEGER,
    session_date DATE,
    start_time TIME,
    end_time TIME,
    instructor_id UUID, -- referencia a SERVICE_PROVIDERS
    location_override VARCHAR(255),
    is_cancelled BOOLEAN,
    cancellation_reason TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE TRAINING (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    description TEXT,
    modality VARCHAR(50), -- in_person,online,hybrid
    location VARCHAR(255),
    total_sessions INTEGER,
    duration_per_session_minutes INTEGER,
    prerequisites_text TEXT,
    max_participants INTEGER,
    includes_certification BOOLEAN,
    certification_title VARCHAR(255),
    price DECIMAL(10,2),
    tax_category VARCHAR(50),
    is_active BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE TRAINING_ENROLLMENTS (
    id UUID PRIMARY KEY,
    training_id UUID,
    customer_id UUID,
    enrolled_date TIMESTAMP,
    status VARCHAR(50), -- active,completed,cancelled,dropped
    completion_date TIMESTAMP,
    amount_paid DECIMAL(10,2),
    invoice_line_item_id UUID,
    notes TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- SCHEMA: BILLING
CREATE TABLE CONTACTS (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    whatsapp_id VARCHAR(255),
    instagram_id VARCHAR(255),
    facebook_id VARCHAR(255),
    telegram_id VARCHAR(255),
    custom_fields_json JSONB,
    tags TEXT[],
    is_archived BOOLEAN,
    birthdate DATE,
    address VARCHAR(255),
    city VARCHAR(255),
    postal_code VARCHAR(50),
    country VARCHAR(50) DEFAULT 'AR',
    status VARCHAR(50), -- prospect,customer,inactive
    first_contact_date TIMESTAMP,
    last_visit_date DATE,
    preferred_service VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE CUSTOMERS (
    id UUID PRIMARY KEY,
    contact_id UUID, -- referencia a CONTACTS
    tax_id VARCHAR(50), -- CUIT/DNI
    first_purchase_date TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE INVOICES (
    id UUID PRIMARY KEY,
    customer_id UUID,
    issued_by_user_id UUID,
    invoice_number INTEGER, -- ARCA sequential
    invoice_type VARCHAR(10), -- A,B,C
    subtotal DECIMAL(10,2),
    tax_amount DECIMAL(10,2), -- IVA
    total_amount DECIMAL(10,2),
    description TEXT,
    status VARCHAR(50), -- draft,emitted,paid,cancelled
    invoice_date TIMESTAMP,
    due_date TIMESTAMP,
    emitted_at TIMESTAMP, -- ARCA timestamp
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE SERVICE (
    id UUID PRIMARY KEY,
    name VARCHAR(255), -- Ej: Depilación láser
    description VARCHAR(255),
    code VARCHAR(50), -- SKU optional
    unit_price DECIMAL(10,2),
    unit_type VARCHAR(50), -- service,product
    tax_category VARCHAR(50), -- VAT21,VAT10.5,exempt
    requires_operator BOOLEAN,
    requires_machine BOOLEAN,
    estimated_duration_minutes INTEGER,
    is_active BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE PROMOTIONS (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    description TEXT,
    promotion_type VARCHAR(50), -- discount_percentage, etc
    discount_percentage DECIMAL(5,2),
    discount_amount DECIMAL(10,2),
    valid_from DATE,
    valid_until DATE,
    status VARCHAR(50), -- active,inactive,expired
    usage_limit INTEGER,
    times_used INTEGER,
    notes TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE PROMOTION_SERVICE (
    id UUID PRIMARY KEY,
    promotion_id UUID,
    service_id UUID,
    notes TEXT,
    created_at TIMESTAMP
);

CREATE TABLE PROMOTION_PRODUCT (
    id UUID PRIMARY KEY,
    promotion_id UUID,
    product_id UUID,
    notes TEXT,
    created_at TIMESTAMP
);

CREATE TABLE PRODUCTS (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    description VARCHAR(255),
    code VARCHAR(50),
    unit_price DECIMAL(10,2),
    quantity_in_stock INTEGER,
    unit_type VARCHAR(50),
    tax_category VARCHAR(50),
    supplier_info TEXT,
    is_active BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE LINE_ITEMS (
    id UUID PRIMARY KEY,
    invoice_id UUID,
    service_id UUID,
    product_id UUID,
    training_enrollment_id UUID,
    quantity INTEGER,
    unit_price DECIMAL(10,2),
    tax_amount DECIMAL(10,2),
    subtotal DECIMAL(10,2),
    total_amount DECIMAL(10,2),
    created_at TIMESTAMP
);

CREATE TABLE PAYMENTS (
    id UUID PRIMARY KEY,
    invoice_id UUID,
    payment_account_id UUID,
    amount DECIMAL(10,2),
    payment_method VARCHAR(50),
    status VARCHAR(50),
    payment_date TIMESTAMP,
    reference VARCHAR(255),
    notes TEXT,
    is_declared BOOLEAN,
    confirmed_by_user_id UUID,
    confirmed_at TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE USERS (
    id UUID PRIMARY KEY,
    email VARCHAR(255),
    full_name VARCHAR(255),
    role VARCHAR(50),
    is_active BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE ARCA_LOGS (
    id UUID PRIMARY KEY,
    invoice_id UUID,
    cae VARCHAR(100),
    cae_expiry TIMESTAMP,
    arca_response_code VARCHAR(50),
    arca_full_response JSONB,
    retry_count INTEGER,
    last_retry_at TIMESTAMP,
    status VARCHAR(50),
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE PAYMENT_LOGS (
    id UUID PRIMARY KEY,
    payment_id UUID,
    event_type VARCHAR(50),
    provider VARCHAR(50),
    raw_data JSONB,
    status VARCHAR(50),
    created_at TIMESTAMP
);

CREATE TABLE CASH_REGISTER (
    id UUID PRIMARY KEY,
    payment_id UUID,
    amount DECIMAL(10,2),
    source VARCHAR(50),
    description TEXT,
    is_declared BOOLEAN,
    registered_by_user_id UUID,
    status VARCHAR(50),
    registration_date TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- SCHEMA: WEB
CREATE TABLE COMPANY_CONFIG (
    id UUID PRIMARY KEY,
    company_name VARCHAR(255),
    company_description VARCHAR(255),
    about_us TEXT,
    address VARCHAR(255),
    phone VARCHAR(50),
    email VARCHAR(255),
    website VARCHAR(255),
    instagram VARCHAR(255),
    facebook VARCHAR(255),
    whatsapp VARCHAR(50),
    last_modified_at TIMESTAMP
);

CREATE TABLE OPEN_HOURS (
    id UUID PRIMARY KEY,
    day_of_week INTEGER,
    opening_time TIME,
    closing_time TIME,
    is_open BOOLEAN,
    notes TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE PAYMENT_ACCOUNTS (
    id UUID PRIMARY KEY,
    account_type VARCHAR(50),
    account_number VARCHAR(100),
    bank_name VARCHAR(255),
    account_owner_name VARCHAR(255),
    account_owner_dni VARCHAR(50),
    currency VARCHAR(10),
    alias VARCHAR(100),
    is_active BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE MERCADOPAGO_ACCOUNTS (
    id UUID PRIMARY KEY,
    mercadopago_user_id VARCHAR(100),
    account_owner_name VARCHAR(255),
    account_email VARCHAR(255),
    access_token_encrypted VARCHAR(255),
    public_key_encrypted VARCHAR(255),
    status VARCHAR(50),
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- SCHEMA: CRM
CREATE TABLE CONVERSATIONS (
    id UUID PRIMARY KEY,
    contact_id UUID,
    channel VARCHAR(50),
    status VARCHAR(50),
    assigned_agent_id UUID,
    message_count INTEGER,
    last_message_at TIMESTAMP,
    created_at TIMESTAMP
);

CREATE TABLE MESSAGES (
    id UUID PRIMARY KEY,
    conversation_id UUID,
    sender_type VARCHAR(50),
    content TEXT,
    media_url VARCHAR(255),
    created_at TIMESTAMP
);

CREATE TABLE CAMPAIGNS (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    channel VARCHAR(50),
    message_content TEXT,
    status VARCHAR(50),
    target_count INTEGER,
    sent_count INTEGER,
    failed_count INTEGER,
    scheduled_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP
);

CREATE TABLE DEALS (
    id UUID PRIMARY KEY,
    contact_id UUID,
    pipeline_id UUID,
    stage_id UUID,
    assigned_agent_id UUID,
    appointment_id UUID,
    title VARCHAR(255),
    amount DECIMAL(10,2),
    probability INTEGER,
    service_name VARCHAR(255),
    service_price DECIMAL(10,2),
    senia_amount DECIMAL(10,2),
    senia_paid BOOLEAN,
    senia_paid_date TIMESTAMP,
    total_amount DECIMAL(10,2),
    amount_paid DECIMAL(10,2),
    amount_pending DECIMAL(10,2),
    payment_method VARCHAR(50),
    scheduled_date DATE,
    scheduled_time TIMESTAMP,
    closed_date TIMESTAMP,
    closed_at TIMESTAMP,
    nps_score INTEGER,
    cancelled BOOLEAN,
    cancel_reason VARCHAR(255),
    needs_follow_up BOOLEAN,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE CALL_LOGS (
    id UUID PRIMARY KEY,
    contact_id UUID,
    duration INTEGER,
    transcript TEXT,
    is_success BOOLEAN,
    ai_model VARCHAR(100),
    tokens_used INTEGER,
    created_at TIMESTAMP
);

CREATE TABLE ANALYTICS_EVENTS (
    id UUID PRIMARY KEY,
    event_type VARCHAR(100),
    channel VARCHAR(50),
    agent_id UUID,
    contact_id UUID,
    metadata_json JSONB,
    created_at TIMESTAMP
);

CREATE TABLE FLOWS (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    trigger_type VARCHAR(50),
    nodes_json JSONB,
    edges_json JSONB,
    is_active BOOLEAN,
    version INTEGER,
    created_at TIMESTAMP
);

CREATE TABLE CHANNEL_CREDENTIALS (
    id UUID PRIMARY KEY,
    channel_type VARCHAR(50),
    encrypted_credentials TEXT,
    is_active BOOLEAN,
    created_at TIMESTAMP
);

CREATE TABLE FAQ (
    id UUID PRIMARY KEY,
    question VARCHAR(255),
    answer TEXT,
    category VARCHAR(100),
    is_active BOOLEAN,
    display_order INTEGER,
    keywords TEXT[],
    created_by_user_id UUID,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- SCHEMA: OPERATIONS
CREATE TABLE MACHINES (
    id UUID PRIMARY KEY,
    name VARCHAR(255),
    description TEXT,
    equipment_type VARCHAR(100),
    requires_operator BOOLEAN,
    hourly_cost DECIMAL(10,2),
    status VARCHAR(50),
    purchase_date DATE,
    weight_kg DECIMAL(10,2),
    dimensions VARCHAR(100),
    quantity INTEGER,
    maintenance_count INTEGER,
    last_maintenance_at TIMESTAMP,
    maintenance_notes TEXT,
    supplier_info TEXT,
    warranty_cost DECIMAL(10,2),
    warranty_expiry TIMESTAMP,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE MACHINE_MAINTENANCE_LOGS (
    id UUID PRIMARY KEY,
    machine_id UUID,
    maintenance_date DATE,
    maintenance_type VARCHAR(50),
    description TEXT,
    cost DECIMAL(10,2),
    performed_by VARCHAR(255),
    notes TEXT,
    created_at TIMESTAMP
);

CREATE TABLE SERVICE_PROVIDERS (
    id UUID PRIMARY KEY,
    full_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    document_type VARCHAR(20),
    document_number VARCHAR(50),
    specialties TEXT,
    hire_date DATE,
    end_date DATE,
    status VARCHAR(50),
    hourly_rate DECIMAL(10,2),
    notes TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE SERVICE_MACHINE (
    id UUID PRIMARY KEY,
    service_id UUID,
    machine_id UUID,
    notes TEXT,
    is_primary_machine BOOLEAN,
    created_at TIMESTAMP
);

CREATE TABLE SERVICE_PROVIDER_MACHINE (
    id UUID PRIMARY KEY,
    service_provider_id UUID,
    machine_id UUID,
    certified_date DATE,
    proficiency_level VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMP
);

CREATE TABLE APPOINTMENTS (
    id UUID PRIMARY KEY,
    customer_id UUID,
    service_provider_id UUID,
    machine_id UUID,
    service_id UUID,
    deal_id UUID,
    appointment_start TIMESTAMP,
    appointment_end TIMESTAMP,
    duration_minutes INTEGER,
    service_price DECIMAL(10,2),
    status VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE SERVICE_PROVIDER_AVAILABILITY (
    id UUID PRIMARY KEY,
    service_provider_id UUID,
    day_of_week INTEGER,
    work_start_time TIME,
    work_end_time TIME,
    valid_from DATE,
    valid_until DATE,
    is_active BOOLEAN,
    notes TEXT,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE PROVIDER_SATURDAY_SCHEDULE (
    id UUID PRIMARY KEY,
    service_provider_id UUID,
    saturday_date DATE,
    is_working BOOLEAN,
    work_start_time TIME,
    work_end_time TIME,
    notes TEXT,
    created_at TIMESTAMP
);

CREATE TABLE PROVIDER_AVAILABILITY_EXCEPTIONS (
    id UUID PRIMARY KEY,
    service_provider_id UUID,
    date_exception DATE,
    date_start DATE,
    date_end DATE,
    time_override_start TIME,
    time_override_end TIME,
    exception_type VARCHAR(50),
    reason TEXT,
    is_working BOOLEAN,
    created_by_user_id UUID,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

CREATE TABLE PROVIDER_AVAILABILITY_AUDIT (
    id UUID PRIMARY KEY,
    service_provider_id UUID,
    change_type VARCHAR(50),
    table_affected VARCHAR(100),
    record_id_changed UUID,
    old_values JSONB,
    new_values JSONB,
    changed_by_user_id UUID,
    change_reason TEXT,
    created_at TIMESTAMP
);

-- ==============================================================================
-- 2. ASIGNACIÓN DE LLAVES FORÁNEAS (FOREIGN KEYS)
-- ==============================================================================

ALTER TABLE CATEGORIES ADD CONSTRAINT fk_cat_parent FOREIGN KEY (parent_category_id) REFERENCES CATEGORIES(id);

ALTER TABLE SERVICE_CATEGORY ADD CONSTRAINT fk_svc_cat_service FOREIGN KEY (service_id) REFERENCES SERVICE(id);
ALTER TABLE SERVICE_CATEGORY ADD CONSTRAINT fk_svc_cat_category FOREIGN KEY (category_id) REFERENCES CATEGORIES(id);

ALTER TABLE TRAINING_SCHEDULES ADD CONSTRAINT fk_train_sch_training FOREIGN KEY (training_id) REFERENCES TRAINING(id);
ALTER TABLE TRAINING_SCHEDULES ADD CONSTRAINT fk_train_sch_instructor FOREIGN KEY (instructor_id) REFERENCES SERVICE_PROVIDERS(id);

ALTER TABLE TRAINING_ENROLLMENTS ADD CONSTRAINT fk_train_enr_training FOREIGN KEY (training_id) REFERENCES TRAINING(id);
ALTER TABLE TRAINING_ENROLLMENTS ADD CONSTRAINT fk_train_enr_customer FOREIGN KEY (customer_id) REFERENCES CUSTOMERS(id);
ALTER TABLE TRAINING_ENROLLMENTS ADD CONSTRAINT fk_train_enr_line_item FOREIGN KEY (invoice_line_item_id) REFERENCES LINE_ITEMS(id);

ALTER TABLE CUSTOMERS ADD CONSTRAINT fk_cust_contact FOREIGN KEY (contact_id) REFERENCES CONTACTS(id);

ALTER TABLE INVOICES ADD CONSTRAINT fk_inv_customer FOREIGN KEY (customer_id) REFERENCES CUSTOMERS(id);
ALTER TABLE INVOICES ADD CONSTRAINT fk_inv_user FOREIGN KEY (issued_by_user_id) REFERENCES USERS(id);

ALTER TABLE PROMOTION_SERVICE ADD CONSTRAINT fk_promo_svc_promo FOREIGN KEY (promotion_id) REFERENCES PROMOTIONS(id);
ALTER TABLE PROMOTION_SERVICE ADD CONSTRAINT fk_promo_svc_service FOREIGN KEY (service_id) REFERENCES SERVICE(id);

ALTER TABLE PROMOTION_PRODUCT ADD CONSTRAINT fk_promo_prod_promo FOREIGN KEY (promotion_id) REFERENCES PROMOTIONS(id);
ALTER TABLE PROMOTION_PRODUCT ADD CONSTRAINT fk_promo_prod_product FOREIGN KEY (product_id) REFERENCES PRODUCTS(id);

ALTER TABLE LINE_ITEMS ADD CONSTRAINT fk_li_invoice FOREIGN KEY (invoice_id) REFERENCES INVOICES(id);
ALTER TABLE LINE_ITEMS ADD CONSTRAINT fk_li_service FOREIGN KEY (service_id) REFERENCES SERVICE(id);
ALTER TABLE LINE_ITEMS ADD CONSTRAINT fk_li_product FOREIGN KEY (product_id) REFERENCES PRODUCTS(id);
ALTER TABLE LINE_ITEMS ADD CONSTRAINT fk_li_training FOREIGN KEY (training_enrollment_id) REFERENCES TRAINING_ENROLLMENTS(id);

ALTER TABLE PAYMENTS ADD CONSTRAINT fk_pay_invoice FOREIGN KEY (invoice_id) REFERENCES INVOICES(id);
ALTER TABLE PAYMENTS ADD CONSTRAINT fk_pay_account FOREIGN KEY (payment_account_id) REFERENCES PAYMENT_ACCOUNTS(id);
ALTER TABLE PAYMENTS ADD CONSTRAINT fk_pay_user FOREIGN KEY (confirmed_by_user_id) REFERENCES USERS(id);

ALTER TABLE ARCA_LOGS ADD CONSTRAINT fk_arca_invoice FOREIGN KEY (invoice_id) REFERENCES INVOICES(id);

ALTER TABLE PAYMENT_LOGS ADD CONSTRAINT fk_paylog_payment FOREIGN KEY (payment_id) REFERENCES PAYMENTS(id);

ALTER TABLE CASH_REGISTER ADD CONSTRAINT fk_cash_payment FOREIGN KEY (payment_id) REFERENCES PAYMENTS(id);
ALTER TABLE CASH_REGISTER ADD CONSTRAINT fk_cash_user FOREIGN KEY (registered_by_user_id) REFERENCES USERS(id);

ALTER TABLE CONVERSATIONS ADD CONSTRAINT fk_conv_contact FOREIGN KEY (contact_id) REFERENCES CONTACTS(id);
ALTER TABLE CONVERSATIONS ADD CONSTRAINT fk_conv_agent FOREIGN KEY (assigned_agent_id) REFERENCES USERS(id);

ALTER TABLE MESSAGES ADD CONSTRAINT fk_msg_conversation FOREIGN KEY (conversation_id) REFERENCES CONVERSATIONS(id);

ALTER TABLE DEALS ADD CONSTRAINT fk_deal_contact FOREIGN KEY (contact_id) REFERENCES CONTACTS(id);
ALTER TABLE DEALS ADD CONSTRAINT fk_deal_agent FOREIGN KEY (assigned_agent_id) REFERENCES USERS(id);
ALTER TABLE DEALS ADD CONSTRAINT fk_deal_appointment FOREIGN KEY (appointment_id) REFERENCES APPOINTMENTS(id);
-- (Nota: pipeline_id y stage_id se dejaron como UUID estandar ya que sus tablas no figuran en el diagrama)

ALTER TABLE CALL_LOGS ADD CONSTRAINT fk_call_contact FOREIGN KEY (contact_id) REFERENCES CONTACTS(id);

ALTER TABLE ANALYTICS_EVENTS ADD CONSTRAINT fk_analytics_agent FOREIGN KEY (agent_id) REFERENCES USERS(id);
ALTER TABLE ANALYTICS_EVENTS ADD CONSTRAINT fk_analytics_contact FOREIGN KEY (contact_id) REFERENCES CONTACTS(id);

ALTER TABLE FAQ ADD CONSTRAINT fk_faq_user FOREIGN KEY (created_by_user_id) REFERENCES USERS(id);

ALTER TABLE MACHINE_MAINTENANCE_LOGS ADD CONSTRAINT fk_maint_machine FOREIGN KEY (machine_id) REFERENCES MACHINES(id);

ALTER TABLE SERVICE_MACHINE ADD CONSTRAINT fk_svcmach_service FOREIGN KEY (service_id) REFERENCES SERVICE(id);
ALTER TABLE SERVICE_MACHINE ADD CONSTRAINT fk_svcmach_machine FOREIGN KEY (machine_id) REFERENCES MACHINES(id);

ALTER TABLE SERVICE_PROVIDER_MACHINE ADD CONSTRAINT fk_provmach_provider FOREIGN KEY (service_provider_id) REFERENCES SERVICE_PROVIDERS(id);
ALTER TABLE SERVICE_PROVIDER_MACHINE ADD CONSTRAINT fk_provmach_machine FOREIGN KEY (machine_id) REFERENCES MACHINES(id);

ALTER TABLE APPOINTMENTS ADD CONSTRAINT fk_appt_customer FOREIGN KEY (customer_id) REFERENCES CUSTOMERS(id);
ALTER TABLE APPOINTMENTS ADD CONSTRAINT fk_appt_provider FOREIGN KEY (service_provider_id) REFERENCES SERVICE_PROVIDERS(id);
ALTER TABLE APPOINTMENTS ADD CONSTRAINT fk_appt_machine FOREIGN KEY (machine_id) REFERENCES MACHINES(id);
ALTER TABLE APPOINTMENTS ADD CONSTRAINT fk_appt_service FOREIGN KEY (service_id) REFERENCES SERVICE(id);
ALTER TABLE APPOINTMENTS ADD CONSTRAINT fk_appt_deal FOREIGN KEY (deal_id) REFERENCES DEALS(id);

ALTER TABLE SERVICE_PROVIDER_AVAILABILITY ADD CONSTRAINT fk_provavail_provider FOREIGN KEY (service_provider_id) REFERENCES SERVICE_PROVIDERS(id);

ALTER TABLE PROVIDER_SATURDAY_SCHEDULE ADD CONSTRAINT fk_provsat_provider FOREIGN KEY (service_provider_id) REFERENCES SERVICE_PROVIDERS(id);

ALTER TABLE PROVIDER_AVAILABILITY_EXCEPTIONS ADD CONSTRAINT fk_provexc_provider FOREIGN KEY (service_provider_id) REFERENCES SERVICE_PROVIDERS(id);
ALTER TABLE PROVIDER_AVAILABILITY_EXCEPTIONS ADD CONSTRAINT fk_provexc_user FOREIGN KEY (created_by_user_id) REFERENCES USERS(id);

ALTER TABLE PROVIDER_AVAILABILITY_AUDIT ADD CONSTRAINT fk_provaudit_provider FOREIGN KEY (service_provider_id) REFERENCES SERVICE_PROVIDERS(id);
ALTER TABLE PROVIDER_AVAILABILITY_AUDIT ADD CONSTRAINT fk_provaudit_user FOREIGN KEY (changed_by_user_id) REFERENCES USERS(id);